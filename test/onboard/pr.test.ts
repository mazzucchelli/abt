import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { FakeOnboardHost } from "../../src/onboard/fake-host.ts";
import { FakeProbe, soloPrivateFacts } from "../../src/onboard/fake.ts";
import { propose } from "../../src/onboard/propose.ts";
import { buildBundle, openOnboardingPr, BUNDLE_PATHS, CLAUDE_POINTER } from "../../src/onboard/bundle.ts";
import { policyProblems, sha256 } from "../../src/landing/policy.ts";
import { parseAdapterDoc } from "../../src/tracker/config.ts";

const landDefault = readFileSync(new URL("../../defaults/trees/land.yaml", import.meta.url), "utf8");
const files = ["src/a.ts", "test/a.test.ts"];
const answers = { tracker: { team: "ABT", credentials: { env: "LINEAR_API_KEY" } }, landTree: landDefault };

async function bundle(claudeMd?: string) {
  const proposal = await propose(new FakeProbe(soloPrivateFacts(), files));
  return { proposal, bundle: buildBundle({ proposal, ...answers, ...(claudeMd !== undefined && { claudeMd }) }) };
}

test("the bundle holds a valid policy whose land_tree_hash matches the generated land tree", async () => {
  const { bundle: b } = await bundle();
  const policy = b.files[BUNDLE_PATHS.policy]!;
  assert.deepEqual(policyProblems(policy), []);
  assert.equal(parse(policy).land_tree_hash, sha256(b.files[BUNDLE_PATHS.landTree]!));
  assert.equal(b.files[BUNDLE_PATHS.landTree], landDefault);
});

test("the bundle holds the facts snapshot, a parsable adapter doc and the CLAUDE.md pointer", async () => {
  const { bundle: b, proposal } = await bundle("# Project\n\nSome rules.\n");
  assert.equal(parse(b.files[BUNDLE_PATHS.facts]!).id, proposal.facts.id);
  assert.equal(parseAdapterDoc(b.files[BUNDLE_PATHS.adapter]!).tracker.team, "ABT");
  const claude = b.files["CLAUDE.md"]!;
  assert.ok(claude.startsWith("# Project\n\nSome rules.\n"));
  assert.equal(claude.split("\n").filter((l) => l === CLAUDE_POINTER).length, 1);
});

test("the pointer is not added twice, and CLAUDE.md is created when absent", async () => {
  const again = await bundle(`# P\n\n${CLAUDE_POINTER}\n`);
  assert.equal(again.bundle.files["CLAUDE.md"]!.split(CLAUDE_POINTER).length - 1, 1);
  assert.equal((await bundle()).bundle.files["CLAUDE.md"], `${CLAUDE_POINTER}\n`);
});

test("opening the PR sends exactly the bundle to the host and leaves the default branch untouched", async () => {
  const { proposal, bundle: b } = await bundle();
  const host = new FakeOnboardHost();
  const pr = await openOnboardingPr(host, proposal, b);
  assert.equal(host.opened.length, 1);
  assert.deepEqual(Object.keys(host.opened[0]!.files).sort(), Object.keys(b.files).sort());
  assert.match(host.opened[0]!.body, /solo-self/);
  assert.equal((await host.readState(pr.number)).state, "open");
  assert.equal(await host.read(BUNDLE_PATHS.policy), undefined);
});
