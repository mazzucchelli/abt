import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { MemoryTrees } from "../src/trees.ts";
import { PrValidator, VALIDATE_CONTEXT, isAbtFile } from "../src/pr-validation.ts";

const GOOD_TREE = "check: pr-exists\n";
const BAD_TREE = "check: branch-up-to-dat\n";
const plugin = new MemoryTrees("defaults/trees", {});
const make = (host: FakeCodeHost) => new PrValidator({ host, plugin });
const last = (h: FakeCodeHost) => h.statuses.at(-1)!;

test("which paths count as abt files", () => {
  for (const f of [".agents/abt/trees/implement.yaml", ".agents/abt/workflow.md", ".agents/abt/policy.yaml", ".agents/abt/checks/lint.sh"]) assert.ok(isAbtFile(f), f);
  for (const f of ["src/index.ts", "README.md", ".agents/other/x.yaml"]) assert.ok(!isAbtFile(f), f);
});

test("an invalid tree gets a failing abt/validate status carrying the file:line:col error", async () => {
  const host = new FakeCodeHost();
  host.addPr("sha1", { ".agents/abt/trees/implement.yaml": BAD_TREE, "src/a.ts": "x" });
  await make(host).sweep();
  assert.equal(host.statuses.length, 1);
  const { sha, status } = last(host);
  assert.equal(sha, "sha1");
  assert.equal(status.context, VALIDATE_CONTEXT);
  assert.equal(status.state, "failure");
  assert.match(status.description, /^\.agents\/abt\/trees\/implement\.yaml:1:8 unknown check "branch-up-to-dat"/);
});

test("a valid tree gets a passing status", async () => {
  const host = new FakeCodeHost();
  host.addPr("sha1", { ".agents/abt/trees/implement.yaml": GOOD_TREE });
  await make(host).sweep();
  assert.equal(last(host).status.state, "success");
});

test("a PR that touches no abt file gets no status", async () => {
  const host = new FakeCodeHost();
  host.addPr("sha1", { "src/a.ts": "x" });
  await make(host).sweep();
  assert.deepEqual(host.statuses, []);
});

test("a tree may `use` another tree of the same PR", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/trees/a.yaml": "use: b\n", ".agents/abt/trees/b.yaml": GOOD_TREE });
  await make(host).sweep();
  assert.equal(last(host).status.state, "success");
});

test("a `use` of a tree that exists nowhere fails with its position in the PR's file", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/trees/a.yaml": "use: nope\n" });
  await make(host).sweep();
  assert.equal(last(host).status.state, "failure");
  assert.match(last(host).status.description, /^\.agents\/abt\/trees\/a\.yaml:1:6 use "nope"/);
});

test("a deleted tree file is not validated", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/trees/old.yaml": null });
  await make(host).sweep();
  assert.equal(last(host).status.state, "success");
});

test("several errors: the first is in the description with a count of the rest, and all are in the failure", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/trees/a.yaml": BAD_TREE, ".agents/abt/trees/b.yaml": BAD_TREE });
  await make(host).sweep();
  assert.match(last(host).status.description, /a\.yaml:1:8 .*\(\+1 more\)$/);
  assert.ok(last(host).status.description.length <= 140);
});

test("a broken adapter doc fails with file:line:col", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/workflow.md": "no front matter here" });
  await make(host).sweep();
  assert.equal(last(host).status.state, "failure");
  assert.match(last(host).status.description, /^\.agents\/abt\/workflow\.md:1:1 adapter doc has no YAML front matter/);
});

test("a policy file that is not valid YAML fails with its position", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/policy.yaml": "ok: 1\nbad: [unclosed\n" });
  await make(host).sweep();
  assert.equal(last(host).status.state, "failure");
  assert.match(last(host).status.description, /^\.agents\/abt\/policy\.yaml:\d+:\d+ /);
});

test("check scripts need no validation but still get a passing status", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/checks/lint.sh": "#!/bin/sh\n" });
  await make(host).sweep();
  assert.equal(last(host).status.state, "success");
});

test("a head commit is validated once; a new push is validated again", async () => {
  const host = new FakeCodeHost();
  const v = make(host);
  host.addPr("sha1", { ".agents/abt/trees/a.yaml": GOOD_TREE }, 1);
  await v.sweep();
  await v.sweep();
  assert.equal(host.statuses.length, 1);
  host.addPr("sha2", { ".agents/abt/trees/a.yaml": GOOD_TREE }, 1);
  // the fake lists both heads of PR 1; the new one is the one that is new
  await v.sweep();
  assert.equal(host.statuses.length, 2);
});

test("a host that fails to answer leaves the PR unvalidated and is retried on the next sweep", async () => {
  const host = new FakeCodeHost();
  host.addPr("s", { ".agents/abt/trees/a.yaml": GOOD_TREE });
  let fail = true;
  const flaky = Object.assign(Object.create(host), {
    readFile: (...a: Parameters<FakeCodeHost["readFile"]>) => (fail ? Promise.reject(new Error("503")) : host.readFile(...a)),
    postStatus: host.postStatus.bind(host),
    openPrs: host.openPrs.bind(host),
  });
  const errors: unknown[] = [];
  const v = new PrValidator({ host: flaky, plugin, onError: (e) => errors.push(e) });
  await v.sweep();
  assert.equal(errors.length, 1);
  assert.deepEqual(host.statuses, []);
  fail = false;
  await v.sweep();
  assert.equal(last(host).status.state, "success");
});
