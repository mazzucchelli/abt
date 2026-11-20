import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const abt = (...args: string[]) =>
  spawnSync("bin/abt", args, { encoding: "utf8" });

test("abt validate exits 0 on a valid tree", () => {
  const r = abt("validate", "test/fixtures/valid.yaml");
  assert.equal(r.status, 0);
});

test("abt validate exits non-zero and prints file:line:col diagnostics on an invalid tree", () => {
  const r = abt("validate", "test/fixtures/invalid.yaml");
  assert.notEqual(r.status, 0);
  assert.equal(
    r.stderr.trim(),
    'test/fixtures/invalid.yaml:1:8 unknown check "branch-up-to-dat" (did you mean "branch-up-to-date"? known: branch-up-to-date, required-checks-green, diff-size, trees-valid, feedback-check, pr-exists)',
  );
});

test("abt validate exits non-zero when the file is missing", () => {
  const r = abt("validate", "test/fixtures/nope.yaml");
  assert.notEqual(r.status, 0);
});

for (const sub of ["onboard", "upgrade"]) {
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

import { mkdtempSync, readFileSync } from "node:fs";
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
