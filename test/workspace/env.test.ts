import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerEnvs } from "../../src/workspace/env.ts";
import { parseAdapterDoc, AdapterConfigError } from "../../src/tracker/config.ts";

const config = { ports: { web: 3000, api: 4000 }, database: "app_{ticket}", buildDir: ".abt-build/{ticket}" };
const dir = () => mkdtempSync(join(tmpdir(), "abt-env-"));

test("two workers at once get different ports, databases and build output", () => {
  const envs = new WorkerEnvs(dir(), config);
  const a = envs.allocate("ABT-1", "/w/ABT-1");
  const b = envs.allocate("ABT-2", "/w/ABT-2");
  assert.notEqual(a.ports.web, b.ports.web);
  assert.notEqual(a.ports.api, b.ports.api);
  assert.notEqual(a.database, b.database);
  assert.notEqual(a.buildDir, b.buildDir);
  assert.equal(a.database, "app_abt_1");
  assert.equal(a.buildDir, "/w/ABT-1/.abt-build/ABT-1");
  assert.equal(a.vars.ABT_PORT_WEB, String(a.ports.web));
  assert.equal(a.vars.ABT_DATABASE, "app_abt_1");
  assert.equal(a.vars.ABT_BUILD_DIR, a.buildDir);
});

test("a ticket keeps its allocation, a released lane is reused, and a restart remembers", () => {
  const d = dir();
  const envs = new WorkerEnvs(d, config);
  const a = envs.allocate("ABT-1", "/w/1");
  envs.allocate("ABT-2", "/w/2");
  assert.deepEqual(envs.allocate("ABT-1", "/w/1"), a);
  assert.deepEqual(new WorkerEnvs(d, config).allocate("ABT-1", "/w/1"), a);
  envs.release("ABT-1");
  assert.equal(envs.allocate("ABT-3", "/w/3").lane, a.lane);
  envs.release("NOPE");
});

test("no isolation config means no variables", () => {
  const e = new WorkerEnvs(dir(), undefined).allocate("ABT-1", "/w");
  assert.deepEqual(e.vars, {});
});

test("the adapter doc's isolation section is parsed and validated", () => {
  const base = `---\ntracker:\n  kind: linear\n  team: ABT\n  credentials: { env: LINEAR_API_KEY }\n  states: { Todo: a, In progress: b, In review: c, Needs you: d, Done: e, Abandoned: f }\n`;
  const ok = parseAdapterDoc(`${base}isolation:\n  ports: { web: 3000 }\n  database: "db_{lane}"\n  buildDir: out/{ticket}\n---\n`);
  assert.deepEqual(ok.isolation, { ports: { web: 3000 }, database: "db_{lane}", buildDir: "out/{ticket}" });
  assert.equal(parseAdapterDoc(`${base}---\n`).isolation, undefined);
  assert.throws(() => parseAdapterDoc(`${base}isolation:\n  ports: { web: 0 }\n---\n`), AdapterConfigError);
  assert.throws(() => parseAdapterDoc(`${base}isolation:\n  nope: 1\n---\n`), /unknown key/);
});

test("loadIsolation reads the project's adapter doc, and is undefined without one", async () => {
  const { loadIsolation } = await import("../../src/tracker/config.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const p = dir();
  assert.equal(loadIsolation(p), undefined);
  mkdirSync(join(p, ".agents/abt"), { recursive: true });
  writeFileSync(join(p, ".agents/abt/workflow.md"), `---\ntracker:\n  kind: linear\n  team: ABT\n  credentials: { env: LINEAR_API_KEY }\n  states: { Todo: a, In progress: b, In review: c, Needs you: d, Done: e, Abandoned: f }\nisolation:\n  ports: { web: 3000 }\n---\n`);
  assert.deepEqual(loadIsolation(p), { ports: { web: 3000 } });
});
