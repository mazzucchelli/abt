import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeOnboardHost } from "../../src/onboard/fake-host.ts";
import { FakeProbe, soloPrivateFacts } from "../../src/onboard/fake.ts";
import { propose } from "../../src/onboard/propose.ts";
import { BUNDLE_PATHS, buildBundle, openOnboardingPr } from "../../src/onboard/bundle.ts";
import { FilePins, MemoryPins, acceptPins, checkPins, isProtected, settleOnboarding } from "../../src/onboard/pins.ts";
import { readFileSync } from "node:fs";

const land = readFileSync(new URL("../../defaults/trees/land.yaml", import.meta.url), "utf8");
const PROJECT = "me__solo";

async function onboarded() {
  const host = new FakeOnboardHost({ "src/a.ts": "x" });
  const proposal = await propose(new FakeProbe(soloPrivateFacts(), ["src/a.ts"]));
  const pr = await openOnboardingPr(host, proposal, buildBundle({ proposal, tracker: { team: "ABT", credentials: { env: "LINEAR_API_KEY" } }, landTree: land }));
  const pins = new MemoryPins();
  await pins.writePending(PROJECT, pr.number);
  const settle = () => settleOnboarding({ host, files: host, pins, project: PROJECT });
  return { host, pins, pr, settle };
}

test("the protected files are the policy, adapter doc, facts snapshot, trees and check scripts", () => {
  for (const p of [".agents/abt/merge-policy.yaml", ".agents/abt/workflow.md", ".agents/abt/facts.yaml", ".agents/abt/trees/land.yaml", ".agents/abt/checks/lint.sh"]) assert.ok(isProtected(p), p);
  for (const p of ["CLAUDE.md", "src/a.ts", ".agents/abt/notes.md"]) assert.ok(!isProtected(p), p);
});

test("before the PR is merged nothing is pinned and the project stays unpinned", async () => {
  const w = await onboarded();
  assert.equal(await w.settle(), "waiting");
  assert.equal((await checkPins(w.host, w.pins, PROJECT)).status, "unpinned");
});

test("after the hand merge the pins are written and the project checks out as pinned", async () => {
  const w = await onboarded();
  w.host.handMerge(w.pr.number);
  assert.equal(await w.settle(), "pinned");
  const pins = (await w.pins.readPins(PROJECT))!;
  assert.deepEqual(Object.keys(pins.files).sort(), [BUNDLE_PATHS.policy, BUNDLE_PATHS.facts, BUNDLE_PATHS.adapter, BUNDLE_PATHS.landTree].sort());
  assert.equal((await checkPins(w.host, w.pins, PROJECT)).status, "pinned");
  assert.equal(await w.pins.readPending(PROJECT), undefined);
});

test("editing a protected file without its pin is a mismatch, and so is adding or removing one", async () => {
  const w = await onboarded();
  w.host.handMerge(w.pr.number);
  await w.settle();
  w.host.commit(BUNDLE_PATHS.policy, "mode: merge\n");
  assert.deepEqual(await checkPins(w.host, w.pins, PROJECT), { status: "mismatch", changed: [BUNDLE_PATHS.policy] });
  await acceptPins({ files: w.host, pins: w.pins, project: PROJECT });
  assert.equal((await checkPins(w.host, w.pins, PROJECT)).status, "pinned");
  w.host.commit(".agents/abt/trees/implement.yaml", "id: implement\n");
  assert.deepEqual(await checkPins(w.host, w.pins, PROJECT), { status: "mismatch", changed: [".agents/abt/trees/implement.yaml"] });
});

test("a PR closed unmerged writes no pins and ends the wait", async () => {
  const w = await onboarded();
  w.host.closePr(w.pr.number);
  assert.equal(await w.settle(), "closed");
  assert.equal(await w.pins.readPins(PROJECT), undefined);
  assert.equal(await w.pins.readPending(PROJECT), undefined);
});

test("pins live in the abt home, outside the repo, and survive a restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "abt-pins-"));
  const a = new FilePins(home);
  await a.writePins(PROJECT, { recordedAt: "2026-11-21T00:00:00Z", files: { x: "h" } });
  await a.writePending(PROJECT, 7);
  const b = new FilePins(home);
  assert.deepEqual(await b.readPins(PROJECT), { recordedAt: "2026-11-21T00:00:00Z", files: { x: "h" } });
  assert.equal(await b.readPending(PROJECT), 7);
  assert.ok(existsSync(join(home, "pins")) && readdirSync(join(home, "pins")).length > 0);
  await b.clearPending(PROJECT);
  assert.equal(await new FilePins(home).readPending(PROJECT), undefined);
});

test("the pins are those of the merge commit, so a change that lands before the next scan is a mismatch, not pinned silently", async () => {
  const w = await onboarded();
  w.host.handMerge(w.pr.number);
  w.host.commit(BUNDLE_PATHS.policy, "mode: merge\n"); // lands after the hand merge, before settle
  assert.equal(await w.settle(), "pinned");
  assert.deepEqual(await checkPins(w.host, w.pins, PROJECT), { status: "mismatch", changed: [BUNDLE_PATHS.policy] });
});
