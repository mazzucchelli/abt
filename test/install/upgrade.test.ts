import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallStore, InstallError } from "../../src/install/store.ts";
import { upgrade, type InstallSource, type InstallSelfTest } from "../../src/install/upgrade.ts";

function setup(opts: { passes?: (tag: string) => boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "abt-install-"));
  const store = new InstallStore(home);
  const fetched: string[] = [];
  const source: InstallSource = {
    async fetch(tag, dir) {
      fetched.push(tag);
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", "abt"), `#!/bin/sh\necho ${tag}\n`);
    },
  };
  const tested: string[] = [];
  const selfTest: InstallSelfTest = async (dir, tag) => {
    tested.push(tag);
    const ok = (opts.passes ?? (() => true))(tag);
    return ok ? { ok: true, failures: [] } : { ok: false, failures: ["stop-hook: the dummy Stop hook did not fire"] };
  };
  return { home, store, source, selfTest, fetched, tested, run: (tag: string) => upgrade(tag, { store, source, selfTest }) };
}

test("a passing self-test installs the tag and switches current to it", async () => {
  const s = setup();
  const r = await s.run("v1");
  assert.deepEqual(r, { status: "upgraded", from: undefined, to: "v1" });
  assert.equal(s.store.current(), "v1");
  assert.equal(s.store.currentDir(), s.store.dir("v1"));
  assert.ok(existsSync(join(s.store.dir("v1"), "bin", "abt")));
});

test("a failing self-test leaves current unchanged and does not keep the install", async () => {
  const s = setup({ passes: (t) => t !== "v2" });
  await s.run("v1");
  const r = await s.run("v2");
  assert.equal(r.status, "failed");
  assert.match((r as { failures: string[] }).failures.join(), /stop-hook/);
  assert.equal(s.store.current(), "v1");
  assert.deepEqual(s.store.list(), ["v1"]);
});

test("a failing first install leaves no current at all", async () => {
  const s = setup({ passes: () => false });
  const r = await s.run("v1");
  assert.equal(r.status, "failed");
  assert.equal(s.store.current(), undefined);
  assert.equal(s.store.currentDir(), undefined);
});

test("installs are kept per tag, side by side", async () => {
  const s = setup();
  await s.run("v1");
  await s.run("v2");
  assert.deepEqual(s.store.list(), ["v1", "v2"]);
  assert.equal(s.store.current(), "v2");
});

test("rolling back to an installed tag switches current without fetching or re-testing, and is reported", async () => {
  const s = setup();
  await s.run("v1");
  await s.run("v2");
  s.fetched.length = 0;
  s.tested.length = 0;
  const r = await s.run("v1");
  assert.deepEqual(r, { status: "rolled-back", from: "v2", to: "v1" });
  assert.equal(s.store.current(), "v1");
  assert.deepEqual(s.fetched, []);
  assert.deepEqual(s.tested, []);
});

test("upgrading to the tag that is already current changes nothing", async () => {
  const s = setup();
  await s.run("v1");
  assert.deepEqual(await s.run("v1"), { status: "unchanged", from: "v1", to: "v1" });
});

test("a failed fetch leaves current unchanged and no half install", async () => {
  const s = setup();
  await s.run("v1");
  const source: InstallSource = { fetch: async (_t, dir) => (mkdirSync(dir, { recursive: true }), Promise.reject(new Error("no such tag"))) };
  const r = await upgrade("v9", { store: s.store, source, selfTest: s.selfTest });
  assert.equal(r.status, "failed");
  assert.match((r as { failures: string[] }).failures.join(), /no such tag/);
  assert.equal(s.store.current(), "v1");
  assert.deepEqual(s.store.list(), ["v1"]);
});

test("tags that could escape the installs folder are refused", async () => {
  const s = setup();
  for (const tag of ["../x", "a/b", "", ".hidden", "-rf"]) {
    await assert.rejects(s.run(tag), InstallError);
  }
});

test("switching current replaces the pointer atomically (no moment without one)", async () => {
  const s = setup();
  await s.run("v1");
  await s.run("v2");
  s.store.switchTo("v1");
  assert.equal(s.store.current(), "v1");
  assert.throws(() => s.store.switchTo("v7"), InstallError);
});

test("an install whose self-test never finished is not installed: it is not listed, switched to, or treated as a rollback", async () => {
  const s = setup();
  await s.run("v1");
  mkdirSync(s.store.dir("v2"), { recursive: true });
  s.store.markUnverified("v2");
  assert.deepEqual(s.store.list(), ["v1"]);
  assert.throws(() => s.store.switchTo("v2"), InstallError);
  const r = await s.run("v2");
  assert.equal(r.status, "upgraded");
  assert.ok(s.tested.includes("v2"));
});
