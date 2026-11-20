import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchdAgent, LABEL, type Launchctl } from "../../src/runner/launchd.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abt-launchd-"));
  const calls: string[][] = [];
  const launchctl: Launchctl = { run: async (args) => (calls.push(args), { code: 0, out: "" }) };
  const agent = new LaunchdAgent({
    launchctl, plistDir: join(dir, "LaunchAgents"), uid: 501, home: join(dir, "abt"),
    program: ["/usr/bin/node", "/opt/abt/src/cli.ts", "runner", "run"],
  });
  return { dir, calls, agent, plist: join(dir, "LaunchAgents", `${LABEL}.plist`) };
}

test("start installs a launchd agent that keeps the runner alive and loads it", async () => {
  const s = setup();
  await s.agent.start();
  const plist = readFileSync(s.plist, "utf8");
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  for (const arg of ["/usr/bin/node", "/opt/abt/src/cli.ts", "runner", "run"]) assert.match(plist, new RegExp(`<string>${arg}</string>`));
  assert.match(plist, /<key>ABT_HOME<\/key>\s*<string>[^<]*\/abt<\/string>/);
  assert.deepEqual(s.calls.at(-1), ["bootstrap", "gui/501", s.plist]);
});

test("start is idempotent: it replaces a loaded agent instead of failing", async () => {
  const s = setup();
  await s.agent.start();
  await s.agent.start();
  assert.deepEqual(s.calls.map((c) => c[0]), ["bootout", "bootstrap", "bootout", "bootstrap"]);
});

test("stop unloads the agent and removes the plist so it does not come back at login", async () => {
  const s = setup();
  await s.agent.start();
  await s.agent.stop();
  assert.deepEqual(s.calls.at(-1), ["bootout", `gui/501/${LABEL}`]);
  assert.equal(existsSync(s.plist), false);
});

test("a launchctl failure surfaces its output", async () => {
  const s = setup();
  const agent = new LaunchdAgent({ ...{ launchctl: { run: async (a: string[]) => (a[0] === "bootstrap" ? { code: 5, out: "Input/output error" } : { code: 0, out: "" }) }, plistDir: join(s.dir, "x"), uid: 1, home: s.dir, program: ["abt"] } });
  await assert.rejects(() => agent.start(), /launchctl bootstrap failed \(5\): Input\/output error/);
});
