import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../src/harness/fake.ts";
import { LandingGuard, MemoryGuard } from "../src/landing/guard.ts";
import { snapshotFacts } from "../src/landing/drift.ts";
import { MemoryPolicy } from "../src/landing/policy.ts";
import { DecisionLog } from "../src/log/store.ts";
import { FakeOnboardHost } from "../src/onboard/fake-host.ts";
import { FakeProbe, soloPrivateFacts } from "../src/onboard/fake.ts";
import { MemoryPins, acceptPins } from "../src/onboard/pins.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaultsDir = new URL("../defaults/trees/", import.meta.url).pathname;
const defaults = new DirTrees(defaultsDir);
const landSource = readFileSync(join(defaultsDir, "land.yaml"), "utf8");
const PROJECT = "me__solo";

const policyFile = () =>
  stringify({
    version: 1,
    gates: { required_checks: ["can-merge"], approvals: 1 },
    enforcement: "self",
    compensating_controls: ["runner-sole-merger", "head-sha-recheck"],
    risk_cap: "low",
    mode: "merge",
    evidence: { self_certification: false },
    risk_map: { rules: [], max_lines: 400, max_files: 15 },
    facts: { default_branch: "main", captured_at: "2026-11-20T00:00:00Z", ...snapshotFacts(soloPrivateFacts()) },
    land_tree_hash: createHash("sha256").update(landSource).digest("hex"),
  });

async function world() {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk: "low" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  harness.script("spec-writing", specWriter(tracker));
  let n = 0;
  const newId = () => `id-${++n}`;
  const clock = new FakeClock();
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-guard-")), clock, newId);
  const probe = new FakeProbe(soloPrivateFacts(), []);
  const store = new MemoryGuard();
  const policy = new MemoryPolicy(policyFile());
  const guard = new LandingGuard({ project: PROJECT, probe, store, policy, tracker, main: codeHost });
  const run = () =>
    runTicket({
      ticket: id, tracker, codeHost, harness, workspace: new FakeWorkspace(), log, newId, plugin: defaults,
      project: new MemoryTrees(".agents/abt/trees", {}), policy, guard,
    });
  const state = async () => (await tracker.readTicket(id)).state;
  const green = (sha = "sha-1") => codeHost.setFacts(id, { headSha: sha, jobs: { "can-merge": { state: "success", sha } }, checks: { "branch-up-to-date": true } });
  return { id, tracker, codeHost, log, probe, store, guard, run, state, green };
}

test("a change to branch protection pauses merging and opens Needs you with a facts diff", async () => {
  const w = await world();
  await w.run();
  w.green();
  w.probe.change({ protection: { enforced: true, required_checks: ["can-merge"], approvals: 2 } });
  await w.run();
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  assert.equal(await w.state(), "Needs you");
  const ask = (await w.tracker.readCommentsSince(w.id)).comments.findLast((c) => c.kind === "ask-point")!;
  assert.match(ask.body, /protection/);
  assert.match(ask.body, /"approvals":0/);
  assert.match(ask.body, /"approvals":2/);
  assert.equal((await w.store.read(PROJECT)).pauses[0]?.kind, "drift");
});

test("a change to the write collaborators pauses merging too", async () => {
  const w = await world();
  await w.run();
  w.green();
  w.probe.change({ write_collaborators: ["me", "someone-new"] });
  await w.run();
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  assert.equal(await w.state(), "Needs you");
  const ask = (await w.tracker.readCommentsSince(w.id)).comments.findLast((c) => c.kind === "ask-point")!;
  assert.match(ask.body, /write_collaborators.*someone-new/);
});

test("with no drift the merge goes ahead and the probe is logged", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  assert.equal((await w.run()).result, "ok");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, true);
  assert.equal(await w.state(), "Done");
  const probes = w.log.read(w.id).filter((r) => r.kind === "probe");
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.result, "ok");
  assert.deepEqual((await w.store.read(PROJECT)).pauses, []);
});

test("a red can-merge on the default branch after an autonomous merge pauses merges and opens an unmerged revert PR", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  await w.run();
  const sha = FakeCodeHost.mergeShaOf("abc");
  assert.deepEqual((await w.store.read(PROJECT)).watching.map((x) => x.sha), [sha]);

  await w.guard.watch();
  assert.equal(w.codeHost.reverts.length, 0, "no job has reported yet: keep watching");

  w.codeHost.setMainJob(sha, "can-merge", "failure");
  await w.guard.watch();
  assert.equal(w.codeHost.reverts.length, 1);
  assert.equal(w.codeHost.reverts[0]!.sha, sha);
  assert.equal(w.codeHost.merges.length, 1, "the revert PR is left unmerged");
  const pause = (await w.store.read(PROJECT)).pauses[0]!;
  assert.equal(pause.kind, "post-merge");
  const needsYou = await w.tracker.readTicket(pause.ticket);
  assert.equal(needsYou.state, "Needs you");
  const ask = (await w.tracker.readCommentsSince(pause.ticket)).comments.find((c) => c.kind === "ask-point")!;
  assert.match(needsYou.title, /can-merge/);
  assert.ok(ask.body.includes(w.codeHost.reverts[0]!.url));
  assert.ok(w.codeHost.reverts[0]!.body.includes(sha));
  assert.equal((await w.store.read(PROJECT)).watching.length, 0);
});

test("a green can-merge on the default branch ends the watch quietly", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  await w.run();
  w.codeHost.setMainJob(FakeCodeHost.mergeShaOf("abc"), "can-merge", "success");
  await w.guard.watch();
  assert.equal((await w.store.read(PROJECT)).watching.length, 0);
  assert.deepEqual((await w.store.read(PROJECT)).pauses, []);
  assert.equal(w.codeHost.reverts.length, 0);
});

test("merging resumes only after the human resolves the Needs you", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  w.probe.change({ allow_auto_merge: true });
  await w.run();
  assert.equal(await w.state(), "Needs you");
  const gate = () => w.guard.beforeMerge({ ticket: w.id, run: "r", log: w.log, policy: parse(policyFile()) });

  // The change is undone on the code host, but the human has not answered: still paused.
  w.probe.change({ allow_auto_merge: false });
  const held = await gate();
  assert.equal(held.ok, false);
  assert.ok(!held.ok && /paused/.test(held.why));

  await w.tracker.setState(w.id, "In review");
  assert.deepEqual(await gate(), { ok: true });
  assert.deepEqual((await w.store.read(PROJECT)).pauses, []);
});

test("resolving the Needs you does not lift a pause while the project still differs from its snapshot", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  w.probe.change({ allow_auto_merge: true });
  await w.run();
  await w.tracker.setState(w.id, "In review");
  assert.equal((await w.run()).result, "fail");
  assert.equal(await w.state(), "Needs you");
});

test("when the runner starts, a drift opens a Needs you before any ticket lands", async () => {
  const w = await world();
  w.probe.change({ write_apps: ["new-deploy-key"] });
  await w.guard.start();
  const pause = (await w.store.read(PROJECT)).pauses[0]!;
  assert.equal(pause.kind, "drift");
  const t = await w.tracker.readTicket(pause.ticket);
  assert.equal(t.state, "Needs you");
  assert.match(t.body, /write_apps/);
  await w.guard.start();
  assert.equal((await w.tracker.listByState("Needs you")).length, 1, "a pause already open is not opened twice");
});

test("a protected file changed without its pin counts as drift", async () => {
  const w = await world();
  const host = new FakeOnboardHost({ ".agents/abt/merge-policy.yaml": "a" });
  const pins = new MemoryPins();
  await acceptPins({ files: host, pins, project: PROJECT });
  const guard = new LandingGuard({ project: PROJECT, probe: w.probe, store: w.store, policy: new MemoryPolicy(policyFile()), tracker: w.tracker, pins: { files: host, store: pins } });
  const gate = () => guard.beforeMerge({ ticket: w.id, run: "r", log: w.log, policy: parse(policyFile()) });
  assert.deepEqual(await gate(), { ok: true });
  host.commit(".agents/abt/merge-policy.yaml", "b");
  const r = await gate();
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /merge-policy\.yaml/.test(r.why));
});

test("the runner re-probes when it starts and watches the default branch on its scan", async () => {
  const { machine } = await import("./runner/machine.ts");
  const m = machine();
  const probe = new FakeProbe(soloPrivateFacts(), []);
  const store = new MemoryGuard();
  const guard = new LandingGuard({ project: PROJECT, probe, store, policy: new MemoryPolicy(policyFile()), tracker: m.tracker, main: m.codeHost });
  m.project.guard = guard;
  probe.change({ visibility: "public" });
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal((await store.read(PROJECT)).pauses[0]?.kind, "drift");
  assert.equal((await m.tracker.listByState("Needs you")).length, 1);

  await guard.recordMerge({ ticket: "X-1", sha: "m1", pr: "https://fake.host/pr/9" });
  m.codeHost.setMainJob("m1", "can-merge", "failure");
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(m.codeHost.reverts.length, 1);
  await r.stop();
});

test("two pauses need both Needs you tickets dealt with before merging resumes", async () => {
  const w = await world();
  await w.run();
  w.green("abc");
  w.probe.change({ allow_auto_merge: true });
  await w.run(); // drift: this ticket is in Needs you
  await w.guard.recordMerge({ ticket: "X-1", sha: "m1", pr: "https://fake.host/pr/9" });
  w.codeHost.setMainJob("m1", "can-merge", "failure");
  await w.guard.watch(); // post-merge: a second ticket in Needs you
  const { pauses } = await w.store.read(PROJECT);
  assert.deepEqual(pauses.map((p) => p.kind), ["drift", "post-merge"]);

  w.probe.change({ allow_auto_merge: false });
  const gate = () => w.guard.beforeMerge({ ticket: w.id, run: "r", log: w.log, policy: parse(policyFile()) });
  await w.tracker.setState(w.id, "In review");
  assert.equal((await gate()).ok, false, "the post-merge Needs you is still open");
  await w.tracker.setState(pauses[1]!.ticket, "Abandoned");
  assert.deepEqual(await gate(), { ok: true });
});

test("a revert PR is opened once even when the watch is retried", async () => {
  const w = await world();
  await w.guard.recordMerge({ ticket: "X-1", sha: "m1", pr: "https://fake.host/pr/9" });
  w.codeHost.setMainJob("m1", "can-merge", "failure");
  const create = w.tracker.createTicket.bind(w.tracker);
  let fail = true;
  w.tracker.createTicket = async (input) => {
    if (fail) { fail = false; throw new Error("tracker down"); }
    return create(input);
  };
  await assert.rejects(() => w.guard.watch(), /tracker down/);
  await w.guard.watch();
  assert.equal(w.codeHost.reverts.length, 1);
});
