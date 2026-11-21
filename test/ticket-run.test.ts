import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../src/harness/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

async function world(project: Record<string, string> = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  harness.script("spec-writing", specWriter(tracker));
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-run-")), new FakeClock(), newId);
  const trees = new MemoryTrees(".agents/abt/trees", project);
  const deps = () => ({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: trees });
  const run = () => runTicket(deps());
  const state = async () => (await tracker.readTicket(id)).state;
  const comments = async () => (await tracker.readCommentsSince(id)).comments;
  return { deps, id, tracker, codeHost, harness, workspace, log, run, state, comments };
}

test("a Todo ticket goes to In review with a PR linked, and every node outcome is logged", async () => {
  const w = await world();
  const r = await w.run();
  assert.equal(r.result, "open");
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "In review");
  assert.deepEqual((await w.tracker.readTicket(w.id)).links.map((l) => l.url), [`https://fake.tracker/${w.id}/spec`, `https://fake.host/${w.id}/pr/1`]);
  assert.deepEqual(w.workspace.events, [`add ${w.id} feat/fake-1-add-the-thing`, `remove ${w.id}`]);

  const outcomes = w.log.read(w.id).filter((x) => x.kind === "node-outcome");
  assert.ok(outcomes.every((x) => x.run === r.run));
  assert.deepEqual(
    outcomes.map((x) => `${x.node}=${x.result}`),
    [
      "claim=ok",
      "implement/0/0/0=fail",
      "implement/0/0/1/0=ok",
      "implement/0/0/1/1=ok",
      "implement/0/0/1=ok",
      "implement/0/0=ok",
      "implement/0=ok",
      "implement/1=ok",
      "implement/2/0=ok",
      "implement/2=ok",
      "implement/3/0=fail",
      "implement/3/1/0=ok",
      "implement/3/1/1=ok",
      "implement/3/1=ok",
      "implement/3=ok",
      "implement/4=open",
      "implement=open",
      "cleanup=ok",
    ],
  );
});

test("at the terminal state one structured summary comment is posted", async () => {
  const w = await world();
  await w.run();
  const summaries = (await w.comments()).filter((c) => c.kind === "summary");
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0]!.data, {
    result: "open",
    tier: "medium",
    tierWhy: "no risk assessment yet; defaulted to medium",
    grade: "standard",
    model: "claude-sonnet-5-5",
    effort: "high",
    askPoints: [],
    logPath: w.log.path(w.id),
  });
});

test("a tree whose action pushes to the default branch is refused by the invariant, before anything runs", async () => {
  const w = await world({ implement: "id: implement\nseq:\n  - agent: tdd\n  - action: push-default-branch\n" });
  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.harness.requests, []);
  assert.deepEqual(w.workspace.events, []);
  const esc = w.log.read(w.id).find((x) => x.kind === "escalation")!;
  assert.match(esc.why, /never push directly/);
  assert.match(esc.why, /implement\.yaml/);
  assert.match((await w.comments()).find((c) => c.kind === "tree-error")!.body, /never push directly/);
});

test("a worker that keeps failing steps up, then ends in cleanup: worktree removed, failure logged, ticket to Needs you", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "fail", why: "tests never went green" });
  let r = await w.run();
  assert.equal(r.terminal, false);
  for (let i = 0; i < 9 && !r.terminal; i++) r = await w.run();
  assert.equal(r.result, "fail");
  assert.equal(await w.state(), "Needs you");
  assert.equal(await w.workspace.find(w.id), undefined);
  // Two failures at standard, one at hard, then nothing left to step up to.
  assert.deepEqual(w.harness.requests.filter((q) => q.procedure === "tdd").map((q) => q.model), ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  const recs = w.log.read(w.id);
  assert.equal(recs.find((x) => x.kind === "node-outcome" && x.node === "implement/2/0")!.why, "tests never went green (exit 1)");
  assert.equal(recs.findLast((x) => x.node === "cleanup")!.result, "ok");
  assert.match(recs.findLast((x) => x.kind === "escalation")!.why, /failed at hard|tests never went green/);
  assert.equal((await w.comments()).filter((c) => c.kind === "summary").length, 1);
});

test("a broken project tree puts the ticket in Needs you with the file:line:col error, and never falls back", async () => {
  const w = await world({ implement: "check: nope\n" });
  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  const c = (await w.comments()).find((x) => x.kind === "tree-error")!;
  assert.match(c.body, /\.agents\/abt\/trees\/implement\.yaml:1:8 unknown check "nope"/);
  assert.equal((c.data as { tree: string }).tree, "implement");
  assert.deepEqual(w.harness.requests, []);
  assert.deepEqual(w.workspace.events, []);
});

test("a project tree replaces the plugin default of the same name", async () => {
  const w = await world({ implement: "id: implement\nagent: custom-skill\n" });
  w.harness.script("custom-skill", { result: "ok" });
  await w.run();
  assert.deepEqual(w.harness.requests.map((q) => q.procedure), ["custom-skill"]);
});

test("a project tree that breaks after the ticket started sends it to Needs you and removes the worktree", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "running" });
  assert.equal((await w.run()).terminal, false);
  assert.ok(await w.workspace.find(w.id));
  const broken = new MemoryTrees(".agents/abt/trees", { implement: "check: nope\n" });
  const r = await runTicket({ ...w.deps(), project: broken });
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.equal(await w.workspace.find(w.id), undefined);
});

test("claim before work: a claim tree that does not claim is refused", async () => {
  const w = await world({ claim: "id: claim\naction: cleanup\n" });
  await w.run();
  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.harness.requests, []);
  assert.match(w.log.read(w.id).find((x) => x.kind === "escalation")!.why, /claim before work/);
});

test("cleanup on every terminal state: a cleanup tree that does not clean up is backed by the runner", async () => {
  const w = await world({ cleanup: "id: cleanup\naction: land\n" });
  await w.run();
  assert.equal(await w.workspace.find(w.id), undefined);
});

test("a running worker leaves the worktree, posts nothing and is polled on the next run", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "running" }, { result: "ok" });
  const first = await w.run();
  assert.equal(first.result, "running");
  assert.equal(first.terminal, false);
  assert.ok(await w.workspace.find(w.id));
  assert.deepEqual((await w.comments()).filter((c) => c.kind !== "spec"), []);
  assert.equal((await w.run()).terminal, true);
  assert.equal(await w.state(), "In review");
  assert.equal(new Set(w.harness.requests.filter((q) => q.procedure === "tdd").map((q) => q.session ?? "")).size, 2);
});

test("re-running after a crash in the middle of the worker step resumes from the facts", async () => {
  const w = await world();
  const real = w.harness.run.bind(w.harness);
  let crashed = false;
  w.harness.run = async (req) => {
    if (!crashed && req.procedure === "tdd") {
      crashed = true;
      throw new Error("process died");
    }
    return real(req);
  };
  await assert.rejects(() => w.run(), /process died/);
  assert.equal(await w.state(), "In progress");
  assert.ok(await w.workspace.find(w.id));

  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "In review");
  assert.equal((await w.tracker.readTicket(w.id)).links.length, 2);
  assert.deepEqual(w.workspace.events, [`add ${w.id} feat/fake-1-add-the-thing`, `remove ${w.id}`]);
});

test("a ticket that is not Todo, In progress or In review is left alone", async () => {
  const w = await world();
  await w.tracker.setState(w.id, "Done");
  const r = await w.run();
  assert.equal(r.result, "skipped");
  assert.deepEqual(w.log.read(w.id), []);
  assert.deepEqual(w.workspace.events, []);
});

test("a crash after the PR was opened but before cleanup still cleans up and summarises on the next run", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "ok" });
  const realRemove = w.workspace.remove.bind(w.workspace);
  let crashed = false;
  w.workspace.remove = async (t) => {
    if (!crashed) {
      crashed = true;
      throw new Error("process died");
    }
    return realRemove(t);
  };
  await assert.rejects(() => w.run(), /process died/);
  assert.equal(await w.state(), "In review");
  assert.ok(await w.workspace.find(w.id));

  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.workspace.find(w.id), undefined);
  assert.equal((await w.comments()).filter((c) => c.kind === "summary").length, 1);
  assert.equal(w.harness.requests.filter((q) => q.procedure === "tdd").length, 1, "the worker is not dispatched again");
});

test("with risk assessment wired in, intake assesses the ticket, labels it and logs the record", async () => {
  const w = await world();
  const t = await w.tracker.createTicket({ title: "fix: refresh the lockfile", body: "Refresh the lockfile in docs/package-lock.json." });
  const classifier = { classify: async () => ({ tier: "low" as const, confidence: 0.9, reasons: ["small"] }) };
  const r = await runTicket({ ...w.deps(), ticket: t.id, risk: { classifier } });
  assert.equal(r.result, "open");
  const rec = w.log.read(t.id).find((x) => x.kind === "risk-assessment")!;
  assert.equal(rec.payload.tier, "medium");
  assert.equal(rec.payload.moment, "intake");
  assert.equal((await w.tracker.readTicket(t.id)).risk, "medium");
  const summary = (await w.tracker.readCommentsSince(t.id)).comments.find((c) => c.kind === "summary")!;
  assert.equal(summary.data!.tier, "medium");
});

test("with keepFailed, a failed run's worktree is kept and stamped instead of removed", async () => {
  const w = await world();
  const clock = new FakeClock();
  w.harness.script("tdd", { result: "fail", why: "tests never went green" });
  let r = await runTicket({ ...w.deps(), keepFailed: clock });
  for (let i = 0; i < 9 && !r.terminal; i++) r = await runTicket({ ...w.deps(), keepFailed: clock });
  assert.equal(await w.state(), "Needs you");
  const [kept] = await w.workspace.list();
  assert.equal(kept!.ticket, w.id);
  assert.equal(kept!.keptSince?.toISOString(), clock.now().toISOString());
});

test("a successful run still removes its worktree even with keepFailed", async () => {
  const w = await world();
  await runTicket({ ...w.deps(), keepFailed: new FakeClock() });
  assert.equal(await w.workspace.find(w.id), undefined);
});
