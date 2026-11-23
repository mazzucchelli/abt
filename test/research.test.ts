import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { FakeJudge } from "../src/judge/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { FAKE_OWNER, InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

async function world(opts: { reviewAuto?: boolean } = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "research: work type trees", body: "what do others do?", workType: "research" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  // The research worker writes to the docs home, links the findings on the ticket and fills the gist.
  harness.script("research", {
    result: "ok",
    effect: async () => {
      await tracker.attachLink(id, { title: "Findings", url: "https://docs.example/findings" });
      await tracker.postComment(id, { kind: "gist", body: "Primary sources agree." });
    },
  });
  const judge = new FakeJudge();
  judge.script({ verdict: true, why: "cites the spec" });
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const clock = new FakeClock();
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-research-")), clock, newId);
  const project = new MemoryTrees(".agents/abt/trees", {});
  const run = () =>
    runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project, judge, ...(opts.reviewAuto !== undefined && { reviewAuto: opts.reviewAuto }) });
  const state = async () => (await tracker.readTicket(id)).state;
  return { id, tracker, codeHost, harness, judge, workspace, log, clock, run, state };
}

test("a research ticket is claimed without a worktree, gets findings linked and reaches Done", async () => {
  const w = await world({ reviewAuto: true });
  const r = await w.run();
  assert.equal(r.result, "ok");
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Done");
  const t = await w.tracker.readTicket(w.id);
  assert.equal(t.claimed, true);
  assert.deepEqual(t.links, [{ title: "Findings", url: "https://docs.example/findings" }]);
  // No worktree and no branch: only a throwaway scratch directory, removed at the end.
  assert.deepEqual(w.workspace.events, [`scratch ${w.id}`, `remove scratch ${w.id}`]);
  assert.equal(await w.workspace.find(w.id), undefined);
  assert.equal(w.harness.requests.length, 1);
  assert.equal(w.harness.requests[0]!.worktree, `/fake/scratch/${w.id}`);
  assert.match(w.harness.requests[0]!.prompt, /docs home/);
});

test("nothing is committed: no PR, no branch, no worktree", async () => {
  const w = await world({ reviewAuto: true });
  await w.run();
  assert.equal((await w.codeHost.readFacts(w.id)).pr, undefined);
  assert.ok(!w.workspace.events.some((e) => e.startsWith("add ")));
  assert.equal(w.workspace.branchOf(w.id), undefined);
});

test("findings that fail the judge send the agent back, with the judge's reason", async () => {
  const w = await world({ reviewAuto: true });
  w.judge.script({ verdict: false, why: "only blog posts" }, { verdict: false, why: "still only blog posts" }, { verdict: true, why: "cites the RFC" });
  const first = await w.run();
  assert.equal(first.result, "running");
  assert.equal(first.terminal, false);
  assert.equal(await w.state(), "In progress");
  const second = await w.run();
  assert.equal(second.result, "ok");
  assert.equal(await w.state(), "Done");
  assert.equal(w.harness.requests.length, 2);
  assert.doesNotMatch(w.harness.requests[0]!.prompt, /rejected/);
  assert.match(w.harness.requests[1]!.prompt, /rejected.*only blog posts/s);
});

test("findings that never pass the judge end in Needs you after the retries", async () => {
  const w = await world({ reviewAuto: true });
  w.judge.script({ verdict: false, why: "no primary sources" });
  assert.equal((await w.run()).result, "running");
  assert.equal((await w.run()).result, "running");
  const last = await w.run();
  assert.equal(last.result, "fail");
  assert.equal(last.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.log.read(w.id).filter((r) => r.kind === "escalation").length, 1);
});

test("with review=auto off the ticket waits for a human ack, then reaches Done", async () => {
  const w = await world();
  const waiting = await w.run();
  assert.equal(waiting.result, "running");
  assert.equal(waiting.terminal, false);
  assert.equal(await w.state(), "In review");

  const again = await w.run();
  assert.equal(again.result, "running");
  assert.equal(w.harness.requests.length, 1, "waiting for the human re-runs no worker");

  const requests = (await w.tracker.readCommentsSince(w.id)).comments.filter((c) => c.kind === "ack-request");
  assert.equal(requests.length, 1, "the owner is asked once, not on every pass");

  await w.tracker.reply(w.id, FAKE_OWNER, "Ack.");
  const done = await w.run();
  assert.equal(done.result, "ok");
  assert.equal(await w.state(), "Done");
});

test("an ack from anyone but the owner, or any other reply, does not close the ticket", async () => {
  const w = await world();
  await w.run();
  await w.tracker.reply(w.id, "someone-else", "ack");
  await w.tracker.reply(w.id, FAKE_OWNER, "ack, but can you add the RFC link?");
  assert.equal((await w.run()).result, "running");
  assert.equal(await w.state(), "In review");
});

test("an ack given before the findings were posted does not count", async () => {
  const w = await world();
  await w.tracker.reply(w.id, FAKE_OWNER, "ack");
  assert.equal((await w.run()).result, "running");
  assert.equal(await w.state(), "In review");
});

test("after the ack timeout escalates, the owner's ack in Needs you closes the ticket", async () => {
  const w = await world();
  await w.run();
  w.clock.advance(3 * 86_400_000);
  assert.equal((await w.run()).result, "fail");
  assert.equal(await w.state(), "Needs you");

  await w.tracker.reply(w.id, FAKE_OWNER, "ack");
  const r = await w.run();
  assert.equal(r.result, "ok");
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Done");
  assert.equal(w.harness.requests.length, 1, "the ack re-runs no worker");
  assert.ok(w.log.read(w.id).some((x) => x.kind === "override" && x.decision === "owner acknowledged the findings"));
});

test("findings that passed the judge are not judged again while the ticket waits for the ack", async () => {
  const w = await world();
  w.judge.script({ verdict: true, why: "cites the spec" }, { verdict: false, why: "changed its mind" });
  assert.equal((await w.run()).result, "running");
  assert.equal((await w.run()).result, "running");
  assert.equal(w.judge.requests.length, 1);
  assert.equal(w.harness.requests.length, 1);
  assert.equal(await w.state(), "In review");
});

test("with review=auto off, an ack that never comes runs the escalation path after the timeout", async () => {
  const w = await world();
  assert.equal((await w.run()).result, "running");
  w.clock.advance(3 * 86_400_000);
  const r = await w.run();
  assert.equal(r.result, "fail");
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "escalation").length, 1);
  assert.equal(await w.workspace.find(w.id), undefined);
});
