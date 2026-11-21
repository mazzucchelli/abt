import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const abt = (...args: string[]) =>
  spawnSync("bin/abt", args, { encoding: "utf8", env: { ...process.env, ABT_UNPINNED: "1" } });

test("abt validate exits 0 on a valid tree", () => {
  const r = abt("validate", "test/fixtures/valid.yaml");
  assert.equal(r.status, 0);
});

test("abt validate exits non-zero and prints file:line:col diagnostics on an invalid tree", () => {
  const r = abt("validate", "test/fixtures/invalid.yaml");
  assert.notEqual(r.status, 0);
  assert.equal(
    r.stderr.trim(),
    'test/fixtures/invalid.yaml:1:8 unknown check "branch-up-to-dat" (did you mean "branch-up-to-date"? known: branch-up-to-date, required-checks-green, diff-size, trees-valid, feedback-check, pr-exists, findings-linked, gist-filled, review-auto)',
  );
});

test("abt validate exits non-zero when the file is missing", () => {
  const r = abt("validate", "test/fixtures/nope.yaml");
  assert.notEqual(r.status, 0);
});

for (const sub of ["onboard"]) {
  test(`abt ${sub} is a stub that exits non-zero`, () => {
    const r = abt(sub);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not implemented/);
  });
}

test("abt with an unknown subcommand prints usage and fails", () => {
  const r = abt("bogus");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: abt/);
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args: string[], home = mkdtempSync(join(tmpdir(), "abt-run-"))) {
  const r = spawnSync("bin/abt", args, { encoding: "utf8", env: { ...process.env, ABT_HOME: home } });
  return { ...r, home, show: () => spawnSync("bin/abt", ["log", "show", "FAKE-1"], { encoding: "utf8", env: { ...process.env, ABT_HOME: home } }).stdout };
}

test("abt run evaluates a tree against a fake world, prints the run table and exits non-zero on fail", () => {
  const r = run(["run", "test/fixtures/land-ish.yaml", "FAKE-1", "--world", "test/fixtures/world/behind.json"]);
  assert.equal(r.status, 1, r.stderr);
  const rows = r.stdout.trimEnd().split("\n");
  assert.match(rows[0]!, /^TIME\s+NODE\s+KIND\s+RESULT/);
  assert.match(r.stdout, /2026-03-01T09:00:00.000Z\s+land\/0\s+node-outcome\s+ok\s+action claim/);
  assert.match(r.stdout, /land\/2\s+node-outcome\s+fail\s+check branch-up-to-date/);
  assert.match(r.stdout, /land\/1\/0\s+node-outcome\s+ok\s+check required-checks-green/);
  assert.match(rows.at(-1)!, /^pass \S+: fail$/);
});

test("abt run writes the records to the ticket's decision log, shown by abt log show", () => {
  const r = run(["run", "test/fixtures/land-ish.yaml", "FAKE-1", "--world", "test/fixtures/world/behind.json"]);
  assert.match(r.show(), /land\/2\s+node-outcome\s+fail/);
  const lines = readFileSync(join(r.home, "log", "FAKE-1.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 8);
});

test("two passes over the same world give the same node results", () => {
  const home = mkdtempSync(join(tmpdir(), "abt-run-"));
  const args = ["run", "test/fixtures/land-ish.yaml", "FAKE-1", "--world", "test/fixtures/world/behind.json"];
  const strip = (s: string) => s.split("\n").map((l) => l.replace(/^pass \S+/, "pass").trimEnd()).join("\n");
  assert.equal(strip(run(args, home).stdout), strip(run(args, home).stdout));
});

test("abt run exits 0 when the tree succeeds", () => {
  const r = run(["run", "test/fixtures/valid.yaml", "FAKE-1", "--world", "test/fixtures/world/behind.json"]);
  assert.equal(r.status, 1); // branch-up-to-date is false in this world
  const ok = run(["run", "test/fixtures/valid-claim.yaml", "FAKE-1", "--world", "test/fixtures/world/behind.json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /: ok$/m);
});

test("abt run reports bad input without running", () => {
  const w = ["--world", "test/fixtures/world/behind.json"];
  assert.match(run(["run", "test/fixtures/nope.yaml", "FAKE-1", ...w]).stderr, /nope\.yaml/);
  assert.match(run(["run", "test/fixtures/invalid.yaml", "FAKE-1", ...w]).stderr, /unknown check/);
  assert.match(run(["run", "test/fixtures/land-ish.yaml", "FAKE-1"]).stderr, /--world/);
  assert.match(run(["run", "test/fixtures/land-ish.yaml", "NOPE-1", ...w]).stderr, /NOPE-1/);
});

function treeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "abt-trees-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("abt validate rejects a use that points to a tree that does not exist", () => {
  const dir = treeDir({ "main.yaml": "seq:\n  - action: claim\n  - use: ghost\n" });
  const r = abt("validate", join(dir, "main.yaml"));
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${join(dir, "main.yaml")}:3:10 use "ghost": no tree named "ghost"`);
});

test("abt validate accepts a use of a sibling tree or of a plugin default tree", () => {
  const dir = treeDir({ "main.yaml": "seq:\n  - use: shared\n  - use: claim\n", "shared.yaml": "action: cleanup\n" });
  assert.equal(abt("validate", join(dir, "main.yaml")).status, 0);
});

test("abt validate follows use into subtrees, and survives a loop", () => {
  const dir = treeDir({ "main.yaml": "use: a\n", "a.yaml": "use: b\n", "b.yaml": "seq:\n  - use: a\n  - use: ghost\n" });
  const r = abt("validate", join(dir, "main.yaml"));
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${join(dir, "b.yaml")}:3:10 use "ghost": no tree named "ghost"`);
});

test("abt validate does not mind placeholders in a subtree, which are filled in at run time", () => {
  const dir = treeDir({ "main.yaml": "use: step\nwith:\n  agent: tdd-afk\n", "step.yaml": "agent: ${agent}\n" });
  assert.equal(abt("validate", join(dir, "main.yaml")).status, 0);
});

test("abt runner status reports a stopped runner with exit 3", () => {
  const home = mkdtempSync(join(tmpdir(), "abt-cli-"));
  const r = spawnSync("bin/abt", ["runner", "status"], { encoding: "utf8", env: { ...process.env, ABT_HOME: home } });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "runner stopped");
});

test("abt runner nudge says so when no runner is listening", () => {
  const home = mkdtempSync(join(tmpdir(), "abt-cli-"));
  const r = spawnSync("bin/abt", ["runner", "nudge", "ABT-1"], { encoding: "utf8", env: { ...process.env, ABT_HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot reach the runner/);
});
