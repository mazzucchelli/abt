import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_PATH, LaunchdAgent, LABEL, missingOnPath, which, type Launchctl } from "../../src/runner/launchd.ts";

function setup(path?: string) {
  const dir = mkdtempSync(join(tmpdir(), "abt-launchd-"));
  const calls: string[][] = [];
  const launchctl: Launchctl = { run: async (args) => (calls.push(args), { code: 0, out: "" }) };
  const agent = new LaunchdAgent({
    launchctl, plistDir: join(dir, "LaunchAgents"), uid: 501, home: join(dir, "abt"),
    program: ["/usr/bin/node", "/opt/abt/src/cli.ts", "runner", "run"],
    ...(path !== undefined && { path }),
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

test("start hands the daemon the PATH it was given, so Homebrew's gh and claude are found", async () => {
  const s = setup("/opt/homebrew/bin:/usr/bin:/bin");
  await s.agent.start();
  assert.match(readFileSync(s.plist, "utf8"), /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.equal(s.agent.installedPath(), "/opt/homebrew/bin:/usr/bin:/bin");
});

test("installedPath is launchd's default for a plist without PATH, and undefined with no agent", async () => {
  const s = setup();
  assert.equal(s.agent.installedPath(), undefined);
  await s.agent.start();
  assert.equal(s.agent.installedPath(), LAUNCHD_PATH);
});

test("which finds an executable on PATH, or by its own path, and missingOnPath names what is not found", () => {
  const dir = mkdtempSync(join(tmpdir(), "abt-which-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\n");
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "notes"), "");
  const path = `/nowhere:${bin}`;
  assert.equal(which("gh", path), join(bin, "gh"));
  assert.equal(which(join(bin, "gh"), "/nowhere"), join(bin, "gh"));
  assert.equal(which("notes", path), undefined, "not executable");
  assert.equal(which("gh", "/nowhere"), undefined);
  assert.deepEqual(missingOnPath([{ command: "gh", why: "GitHub" }, { command: "claude", why: "Claude Code" }], path), [`claude (Claude Code) is not on the runner's PATH ${path}`]);
});
