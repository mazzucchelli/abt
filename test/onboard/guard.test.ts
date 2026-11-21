import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../../src/harness/fake.ts";
import { MemoryPolicy } from "../../src/landing/policy.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { runTicket } from "../../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../../src/trees.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";
import { FakeWorkspace } from "../../src/workspace/fake.ts";
import { FakeOnboardHost } from "../../src/onboard/fake-host.ts";
import { FakeProbe, soloPrivateFacts } from "../../src/onboard/fake.ts";
import { propose } from "../../src/onboard/propose.ts";
import { BUNDLE_PATHS, buildBundle, openOnboardingPr } from "../../src/onboard/bundle.ts";
import { MemoryPins, settleOnboarding } from "../../src/onboard/pins.ts";

const defaults = new DirTrees(new URL("../../defaults/trees/", import.meta.url).pathname);
const land = readFileSync(new URL("../../defaults/trees/land.yaml", import.meta.url), "utf8");
const PROJECT = "me__solo";

/** A project onboarded through the real flow, with a ticket whose PR is open and green. */
async function world() {
  const host = new FakeOnboardHost();
  const proposal = await propose(new FakeProbe(soloPrivateFacts(), ["src/a.ts"]));
  const bundle = buildBundle({ proposal, tracker: { team: "ABT", credentials: { env: "LINEAR_API_KEY" } }, landTree: land });
  const pr = await openOnboardingPr(host, proposal, bundle);
  const pins = new MemoryPins();
  await pins.writePending(PROJECT, pr.number);

  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk: "low" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd-afk", { result: "ok" });
  harness.script("to-spec", specWriter(tracker));
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-guard-")), new FakeClock(), newId);
  // The runner reads the policy from the default branch: only what a hand merge put there.
  const policy = { async read() { const source = await host.read(BUNDLE_PATHS.policy); return source === undefined ? undefined : { source, file: BUNDLE_PATHS.policy }; } };
  const run = () => runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", { land }), policy, pins: { files: host, store: pins, project: PROJECT } });
  const green = (sha = "sha-1") => codeHost.setFacts(id, { headSha: sha, jobs: { "can-merge": { state: "success", sha } }, checks: { "branch-up-to-date": true } });
  const settle = () => settleOnboarding({ host, files: host, pins, project: PROJECT });
  return { host, pr, id, tracker, codeHost, run, green, settle, log };
}

test("before the onboarding PR is merged the project does not merge autonomously; after the hand merge it does", async () => {
  const w = await world();
  assert.equal((await w.run()).result, "open");
  w.green();
  await w.run();
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);

  w.host.handMerge(w.pr.number);
  await w.run(); // merged on the default branch, but the runner has not pinned it yet
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);

  assert.equal(await w.settle(), "pinned");
  assert.equal((await w.run()).result, "ok");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, true);
});

test("editing a protected file without updating its pin puts the project in Needs you and merges nothing", async () => {
  const w = await world();
  await w.run();
  w.green();
  w.host.handMerge(w.pr.number);
  await w.settle();
  w.host.commit(BUNDLE_PATHS.policy, (await w.host.read(BUNDLE_PATHS.policy))!.replace("risk_cap: low", "risk_cap: none"));
  w.host.commit(".agents/abt/trees/land.yaml", land.replace("2d", "9d"));

  await w.run();
  assert.equal((await w.tracker.readTicket(w.id)).state, "Needs you");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  const esc = w.log.read(w.id).findLast((r) => r.kind === "escalation")!;
  assert.match(esc.why, /merge-policy\.yaml/);
  assert.match(esc.why, /trees\/land\.yaml/);
});

test("a ticket that has not started is also held in Needs you on a pin mismatch, before any worker runs", async () => {
  const w = await world();
  w.host.handMerge(w.pr.number);
  await w.settle();
  w.host.commit(BUNDLE_PATHS.adapter, "---\ntracker: {}\n---\n");
  const r = await w.run();
  assert.equal(r.result, "skipped");
  assert.equal((await w.tracker.readTicket(w.id)).state, "Needs you");
});
