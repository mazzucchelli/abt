import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { LockError, RunnerLock, runnerStatus } from "../../src/runner/lock.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abt-lock-"));
  const clock = new FakeClock();
  const alive = new Set<number>();
  const isAlive = (pid: number) => alive.has(pid);
  const lock = (pid: number) => {
    alive.add(pid);
    return new RunnerLock({ dir, clock, pid, isAlive });
  };
  return { dir, clock, alive, isAlive, lock };
}

test("a second instance refuses to start while the first holds the lock", () => {
  const s = setup();
  s.lock(100).acquire();
  assert.throws(() => s.lock(200).acquire(), (e) => e instanceof LockError && /already running \(pid 100\)/.test(e.message));
});

test("a lock left by a dead process is taken over", () => {
  const s = setup();
  const first = s.lock(100);
  first.acquire();
  s.alive.delete(100);
  s.lock(200).acquire();
  assert.equal(runnerStatus({ dir: s.dir, clock: s.clock, isAlive: s.isAlive }).pid, 200);
});

test("releasing the lock lets another instance start", () => {
  const s = setup();
  const first = s.lock(100);
  first.acquire();
  first.release();
  s.lock(200).acquire();
});

test("status reports stopped, running with heartbeat age, and stale when the heartbeat stops", () => {
  const s = setup();
  const q = () => runnerStatus({ dir: s.dir, clock: s.clock, isAlive: s.isAlive });
  assert.deepEqual(q(), { state: "stopped" });
  const lock = s.lock(100);
  lock.acquire();
  lock.heartbeat();
  s.clock.advance(5_000);
  assert.deepEqual(q(), { state: "running", pid: 100, heartbeatAgeMs: 5_000 });
  s.clock.advance(60_000);
  assert.equal(q().state, "stale");
  s.alive.delete(100);
  assert.deepEqual(q(), { state: "stopped" });
});
