import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../../src/harness/fake.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { DispatchStore } from "../../src/runner/dispatch-store.ts";
import { Runner, type RunnerDeps, type RunnerProject } from "../../src/runner/daemon.ts";
import { FakeWorkers } from "../../src/runner/workers.ts";
import { DirTrees, MemoryTrees } from "../../src/trees.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";
import { FakeWorkspace } from "../../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../../defaults/trees/", import.meta.url).pathname);

/** One machine: a fake world shared by every Runner "process" started on it, so a restart sees the same facts. */
export function machine(trees: Record<string, string> = {}, extra: Partial<RunnerDeps> & { project?: Partial<RunnerProject> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "abt-rn-"));
  const clock = new FakeClock();
  const tracker = new InMemoryTracker();
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd-afk", { result: "ok" });
  harness.script("to-spec", specWriter(tracker));
  const workspace = new FakeWorkspace();
  const workers = new FakeWorkers();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(home, clock, newId);
  const { project: projectExtra, ...depsExtra } = extra;
  const project: RunnerProject = {
    ...projectExtra,
    name: "p",
    tracker,
    log,
    deps: (ticket: string) => ({ ticket, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", trees) }),
  };
  const errors: string[] = [];
  let pid = 1000;
  const alive = new Set<number>();
  const runner = () => {
    const p = ++pid;
    alive.add(p);
    return new Runner({
      home, clock, timers: clock, pid: p, isAlive: (x) => alive.has(x), projects: [project], workers, newId,
      store: new DispatchStore(join(home, "dispatch.json")),
      socketPath: join(home, "runner.sock"),
      ...depsExtra,
      onError: (e, where) => errors.push(`${where}: ${(e as Error).message}`),
    });
  };
  const ticket = async (title = "feat: add the thing", more: { priority?: number; blockedBy?: string[] } = {}) => (await tracker.createTicket({ title, body: "", risk: "low", ...more })).id; // low risk: these tests are about dispatch, and a low, covered ticket skips the spec step
  const state = async (id: string) => (await tracker.readTicket(id)).state;
  return { home, clock, tracker, codeHost, harness, workspace, workers, log, project, runner, ticket, state, alive, errors };
}

export async function until(cond: () => Promise<boolean>, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

