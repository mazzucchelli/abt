import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { runPass } from "../src/pass.ts";
import { MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

async function world() {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "t", body: "b" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  const workspace = new FakeWorkspace();
  const clock = new FakeClock();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-sem-")), clock, newId);
  await tracker.claim(id);
  await workspace.ensure(id, "feat/x");
  const pass = (tree: string, extra: Record<string, unknown> = {}) =>
    runPass({ tree, ticket: id, tracker, codeHost, harness, workspace, log, newId, ...extra });
  const outcomes = () => {
    const recs = log.read(id);
    const run = recs.at(-1)!.run;
    return Object.fromEntries(recs.filter((r) => r.run === run && r.kind === "node-outcome").map((r) => [r.node, r.result]));
  };
  return { id, tracker, codeHost, harness, workspace, clock, log, pass, outcomes };
}

const RETRY = "retry: 3\ndo:\n  agent: fixer\n";

test("retry max 3 fails only after the third fail; an infrastructure error never uses a retry and is tried again", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "fail" }, { result: "fail" }, { result: "error" }, { result: "fail" });
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await w.pass(RETRY)).result);
  assert.deepEqual(results, ["running", "running", "running", "fail"]);
  assert.deepEqual(w.log.read(w.id).filter((r) => r.kind === "node-outcome" && r.node === "root/0").map((r) => r.result), ["fail", "fail", "error", "fail"]);
});

test("once retries are used up the child is not run again", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "fail" });
  for (let i = 0; i < 3; i++) await w.pass(RETRY);
  const before = w.harness.requests.length;
  assert.equal((await w.pass(RETRY)).result, "fail");
  assert.equal(w.harness.requests.length, before);
  assert.equal(w.outcomes()["root/0"], "skipped");
});

test("a human override resets the retry count", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "fail" });
  for (let i = 0; i < 3; i++) await w.pass(RETRY);
  w.log.append(w.id, { run: "human", node: null, kind: "override", decision: "try again", why: "human reset", evidence: null, result: "ok", payload: { target: "root", by: "human" } });
  assert.equal((await w.pass(RETRY)).result, "running");
});

test("an ok outcome resets the retry count", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "fail" }, { result: "fail" }, { result: "ok" }, { result: "fail" });
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await w.pass(RETRY)).result);
  assert.deepEqual(results, ["running", "running", "ok", "running"]);
});

const TIMEOUT = "timeout: 1h\ndo:\n  agent: slow\n";

test("timeout fails once the clock passes D after the first running record, across separate passes", async () => {
  const w = await world();
  w.harness.script("slow", { result: "running" });
  assert.equal((await w.pass(TIMEOUT)).result, "running");
  w.clock.advance(30 * 60_000);
  assert.equal((await w.pass(TIMEOUT)).result, "running");
  w.clock.advance(31 * 60_000);
  const before = w.harness.requests.length;
  assert.equal((await w.pass(TIMEOUT)).result, "fail");
  assert.equal(w.harness.requests.length, before, "a timed-out node does not run its child");
  assert.equal(w.outcomes()["root/0"], "skipped");
});

test("the timeout clock starts at the first running record, not at the first pass", async () => {
  const w = await world();
  w.harness.script("slow", { result: "fail" }, { result: "running" });
  await w.pass(TIMEOUT);
  w.clock.advance(2 * 3_600_000);
  assert.equal((await w.pass(TIMEOUT)).result, "running", "no running record yet, so no deadline");
});

test("a human override restarts the timeout", async () => {
  const w = await world();
  w.harness.script("slow", { result: "running" });
  await w.pass(TIMEOUT);
  w.clock.advance(2 * 3_600_000);
  assert.equal((await w.pass(TIMEOUT)).result, "fail");
  w.log.append(w.id, { run: "human", node: null, kind: "override", decision: "more time", why: "human reset", evidence: null, result: "ok", payload: { target: "root", by: "human" } });
  assert.equal((await w.pass(TIMEOUT)).result, "running");
});

const cond = async (tree: string, facts: Record<string, boolean>) => {
  const w = await world();
  for (const [k, v] of Object.entries(facts)) w.codeHost.setCheck(w.id, k as "pr-exists", v);
  return { w, result: (await w.pass(tree)).result };
};

test("all is ok only when every condition holds, and skips the rest after the first that does not", async () => {
  const tree = "all:\n  - check: branch-up-to-date\n  - check: required-checks-green\n  - check: trees-valid\n";
  assert.equal((await cond(tree, { "branch-up-to-date": true, "required-checks-green": true, "trees-valid": true })).result, "ok");
  const { w, result } = await cond(tree, { "branch-up-to-date": true, "required-checks-green": false });
  assert.equal(result, "fail");
  assert.deepEqual(w.outcomes(), { root: "fail", "root/0": "ok", "root/1": "fail", "root/2": "skipped" });
});

test("any is ok when one condition holds, and fails when none does", async () => {
  const tree = "any:\n  - check: branch-up-to-date\n  - check: required-checks-green\n";
  assert.equal((await cond(tree, { "branch-up-to-date": false, "required-checks-green": true })).result, "ok");
  assert.equal((await cond(tree, { "branch-up-to-date": false, "required-checks-green": false })).result, "fail");
});

test("not inverts ok and fail, and passes an unknown fact through as inconclusive", async () => {
  const tree = "not:\n  check: branch-up-to-date\n";
  assert.equal((await cond(tree, { "branch-up-to-date": true })).result, "fail");
  assert.equal((await cond(tree, { "branch-up-to-date": false })).result, "ok");
  assert.equal((await cond(tree, {})).result, "inconclusive");
});

test("conditions nest", async () => {
  const tree = "all:\n  - not:\n      check: diff-size\n  - any:\n      - check: pr-exists\n      - check: trees-valid\n";
  assert.equal((await cond(tree, { "diff-size": false, "trees-valid": true })).result, "ok");
  assert.equal((await cond(tree, { "diff-size": true, "trees-valid": true })).result, "fail");
});

const BUILD = `
id: build
seq:
  - agent: \${agent}
  - id: done
    action: claim
`;

test("a subtree gets its parameters through with:, and its node IDs stay stable", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "ok" });
  w.harness.script("other", { result: "ok" });
  const trees = new MemoryTrees("trees", { build: BUILD });
  const use = (agent: string) => `seq:\n  - check: trees-valid\n  - use: build\n    with:\n      agent: ${agent}\n`;
  w.codeHost.setCheck(w.id, "trees-valid", true);
  await w.pass(use("fixer"), { trees });
  const ids = Object.keys(w.outcomes());
  assert.deepEqual(ids.sort(), ["root", "root/0", "root/1", "root/1/0", "root/1/done"].sort());
  assert.equal(w.harness.requests[0]!.procedure, "fixer");
  await w.pass(use("other"), { trees });
  assert.deepEqual(Object.keys(w.outcomes()).sort(), ids);
  assert.equal(w.harness.requests[1]!.procedure, "other");
});

test("an explicit id on the use node names the subtree root; the subtree's own ids are scoped under it", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "ok" });
  await w.pass("id: step\nuse: build\nwith:\n  agent: fixer\n", { trees: new MemoryTrees("trees", { build: BUILD }) });
  assert.deepEqual(Object.keys(w.outcomes()).sort(), ["step", "step/0", "step/done"]);
});

test("the same subtree can be used twice without its ids colliding", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "ok" });
  const r = await w.pass("seq:\n  - use: build\n    with: { agent: fixer }\n  - use: build\n    with: { agent: fixer }\n", { trees: new MemoryTrees("trees", { build: BUILD }) });
  assert.equal(r.result, "ok");
});

test("a whole-value parameter keeps its type, so it can fill a number", async () => {
  const w = await world();
  w.harness.script("fixer", { result: "fail" });
  const trees = new MemoryTrees("trees", { again: "retry: ${n}\ndo:\n  agent: fixer\n" });
  const results = [];
  for (let i = 0; i < 2; i++) results.push((await w.pass("use: again\nwith:\n  n: 2\n", { trees })).result);
  assert.deepEqual(results, ["running", "fail"]);
});

test("a use that cannot be resolved is refused before anything runs", async () => {
  const w = await world();
  await assert.rejects(() => w.pass("use: nowhere\n", { trees: new MemoryTrees("trees", {}) }), /no tree named "nowhere"/);
  await assert.rejects(() => w.pass("use: nowhere\n"), /no tree named "nowhere"/);
  assert.deepEqual(w.log.read(w.id), []);
});

test("a missing or unknown parameter is refused", async () => {
  const w = await world();
  const trees = new MemoryTrees("trees", { build: BUILD });
  await assert.rejects(() => w.pass("use: build\n", { trees }), /parameter "agent"/);
  await assert.rejects(() => w.pass("use: build\nwith:\n  agent: x\n  extra: y\n", { trees }), /no parameter "extra"/);
});

test("subtrees that use each other in a loop are refused", async () => {
  const w = await world();
  const trees = new MemoryTrees("trees", { a: "use: b\n", b: "use: a\n" });
  await assert.rejects(() => w.pass("use: a\n", { trees }), /cycle/);
});

test("a placeholder in a subtree id is refused, so IDs cannot change with parameters", async () => {
  const w = await world();
  const trees = new MemoryTrees("trees", { s: "id: step-${x}\naction: claim\n" });
  await assert.rejects(() => w.pass("use: s\nwith:\n  x: a\n", { trees }), /node IDs cannot depend on parameters/);
});

test("timeout does not fire at exactly D, only once the clock passes it", async () => {
  const w = await world();
  w.harness.script("slow", { result: "running" });
  await w.pass(TIMEOUT);
  w.clock.advance(3_600_000);
  assert.equal((await w.pass(TIMEOUT)).result, "running");
  w.clock.advance(1);
  assert.equal((await w.pass(TIMEOUT)).result, "fail");
});

test("a subtree is validated after its parameters are filled in", async () => {
  const w = await world();
  const trees = new MemoryTrees("trees", { chk: "check: ${name}\n" });
  await assert.rejects(() => w.pass("use: chk\nwith:\n  name: no-such-check\n", { trees }), /unknown check "no-such-check"/);
});

async function scripted(files: Record<string, string>, timeoutMs = 2000) {
  const dir = mkdtempSync(join(tmpdir(), "abt-scripts-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const w = await world();
  const run = async (tree: string) => ({ result: (await w.pass(tree, { scripts: { dir, timeoutMs } })).result, why: w.log.read(w.id).findLast((r) => r.node === "root")!.why });
  return { w, run };
}

test("a check script's exit code maps to true, false and error", async () => {
  const { run } = await scripted({ ok: "exit 0", no: "exit 1", boom: "exit 2", odd: "exit 127" });
  assert.equal((await run("script: ok")).result, "ok");
  assert.equal((await run("script: no")).result, "fail");
  assert.equal((await run("script: boom")).result, "error");
  assert.equal((await run("script: odd")).result, "error");
  assert.match((await run("script: boom")).why, /exited 2/);
});

test("a script that does not exist, or is not allowed to run, is an error, not false", async () => {
  const { run } = await scripted({});
  assert.equal((await run("script: missing")).result, "error");
  assert.equal((await run("script: ../../etc/passwd")).result, "error");
  assert.match((await run("script: ../x")).why, /outside/);
});

test("a script that outlives its timeout counts as an error", async () => {
  const { run } = await scripted({ slow: "sleep 5" }, 150);
  const r = await run("script: slow");
  assert.equal(r.result, "error");
  assert.match(r.why, /timed out/);
});

test("a script error is not a retryable failure, and not() does not turn it into true", async () => {
  const { w, run } = await scripted({ boom: "exit 2" });
  assert.equal((await run("not:\n  script: boom")).result, "error");
  assert.equal((await run("retry: 2\ndo:\n  script: boom")).result, "running");
  assert.equal(w.log.read(w.id).filter((r) => r.node === "root/0" && r.result === "fail").length, 0);
});
