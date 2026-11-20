import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfigError, loadGlobalConfig } from "../../src/runner/config.ts";

const home = () => mkdtempSync(join(tmpdir(), "abt-cfg-"));

test("the global config lists the onboarded projects", () => {
  const h = home();
  writeFileSync(join(h, "config.yaml"), "projects:\n  - name: abt\n    path: /Users/me/abt\n  - name: site\n    path: /Users/me/site\n");
  assert.deepEqual(loadGlobalConfig(h).projects, [{ name: "abt", path: "/Users/me/abt" }, { name: "site", path: "/Users/me/site" }]);
});

test("no config file means no projects", () => {
  assert.deepEqual(loadGlobalConfig(home()).projects, []);
});

test("a malformed project entry is refused with where it is", () => {
  const h = home();
  writeFileSync(join(h, "config.yaml"), "projects:\n  - name: abt\n");
  assert.throws(() => loadGlobalConfig(h), (e) => e instanceof GlobalConfigError && /projects\[0\]\.path/.test(e.message));
});

test("two projects with the same name are refused", () => {
  const h = home();
  writeFileSync(join(h, "config.yaml"), "projects:\n  - {name: a, path: /x}\n  - {name: a, path: /y}\n");
  assert.throws(() => loadGlobalConfig(h), /duplicate project "a"/);
});

test("the config sets the global slot cap, per-project caps and wall-clock caps", () => {
  const h = home();
  writeFileSync(join(h, "config.yaml"), "maxWorkers: 2\nwallClockMinutes: {hard: 240}\nprojects:\n  - {name: a, path: /x, maxWorkers: 1}\n  - {name: b, path: /y}\n");
  const c = loadGlobalConfig(h);
  assert.deepEqual(c.scheduling, { globalCap: 2, wallClockMinutes: { hard: 240 } });
  assert.deepEqual(c.projects, [{ name: "a", path: "/x", maxWorkers: 1 }, { name: "b", path: "/y" }]);
});

test("a cap that is not a positive whole number is refused", () => {
  const h = home();
  writeFileSync(join(h, "config.yaml"), "maxWorkers: 0\n");
  assert.throws(() => loadGlobalConfig(h), /maxWorkers must be a whole number/);
  writeFileSync(join(h, "config.yaml"), "wallClockMinutes: {huge: 5}\n");
  assert.throws(() => loadGlobalConfig(h), /not a grade/);
});
