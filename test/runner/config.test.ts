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
