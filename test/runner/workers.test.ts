import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessWorkers } from "../../src/runner/workers.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";

const spec = (env: Record<string, string>): SpawnSpec => ({ command: "claude", args: [], cwd: ".", env });
const done: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };

test("a worker's end, clean or not, is reported for its ticket once the spawner returns", async () => {
  const workers = new ProcessWorkers();
  const exits: string[] = [];
  workers.onExit((t) => exits.push(t));
  const ok = workers.tracking(async () => done);
  const boom = workers.tracking(async () => {
    throw new Error("spawn failed");
  });
  let release!: () => void;
  const slow = workers.tracking(() => new Promise((r) => (release = () => r(done))));

  await ok(spec({ ABT_TICKET: "A-1" }));
  await assert.rejects(() => boom(spec({ ABT_TICKET: "A-2" })), /spawn failed/);
  const running = slow(spec({ ABT_TICKET: "A-3" }));
  assert.deepEqual(exits, ["A-1", "A-2"]);
  release();
  await running;
  assert.deepEqual(exits, ["A-1", "A-2", "A-3"]);
});

test("a run with no ticket (a judge, the self-test) reports nothing, and a stopped listener hears nothing", async () => {
  const workers = new ProcessWorkers();
  const exits: string[] = [];
  const stop = workers.onExit((t) => exits.push(t));
  const spawn = workers.tracking(async () => done);
  await spawn(spec({}));
  stop();
  await spawn(spec({ ABT_TICKET: "A-1" }));
  assert.deepEqual(exits, []);
});
