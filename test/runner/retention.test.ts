import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { TranscriptRetention, TRANSCRIPT_RETENTION_DAYS } from "../../src/runner/retention.ts";
import { machine, until } from "./machine.ts";

const DAY = 86_400_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abt-ret-"));
  const clock = new FakeClock();
  const runs = join(dir, "runs");
  const retention = new TranscriptRetention({ runsDir: runs, clock });
  const transcript = (ticket: string) => {
    mkdirSync(join(runs, ticket), { recursive: true });
    const f = join(runs, ticket, "implement-s1.jsonl");
    writeFileSync(f, "{}\n");
    return f;
  };
  return { dir, clock, runs, retention, transcript };
}

test("transcripts are kept 30 days after a terminal state, then pruned", () => {
  const s = setup();
  const f = s.transcript("ABT-1");
  s.retention.markTerminal("ABT-1");
  assert.equal(TRANSCRIPT_RETENTION_DAYS, 30);
  s.clock.advance(30 * DAY - 1);
  assert.deepEqual(s.retention.prune(), []);
  assert.ok(existsSync(f));
  s.clock.advance(2);
  assert.deepEqual(s.retention.prune(), ["ABT-1"]);
  assert.ok(!existsSync(f));
  assert.ok(!existsSync(join(s.runs, "ABT-1")));
});

test("a ticket with no terminal state is never pruned, however old", () => {
  const s = setup();
  const f = s.transcript("ABT-2");
  s.clock.advance(400 * DAY);
  assert.deepEqual(s.retention.prune(), []);
  assert.ok(existsSync(f));
});

test("a ticket that runs again after a terminal state is no longer on the clock", () => {
  const s = setup();
  const f = s.transcript("ABT-3");
  s.retention.markTerminal("ABT-3");
  s.clock.advance(20 * DAY);
  s.retention.clearTerminal("ABT-3");
  s.clock.advance(20 * DAY);
  assert.deepEqual(s.retention.prune(), []);
  assert.ok(existsSync(f));
});

test("marking a ticket that is already on the clock keeps its start", () => {
  const s = setup();
  s.transcript("ABT-4");
  s.retention.markTerminal("ABT-4");
  s.clock.advance(20 * DAY);
  s.retention.markTerminal("ABT-4");
  s.clock.advance(11 * DAY);
  assert.deepEqual(s.retention.prune(), ["ABT-4"]);
});

test("pruning only touches the terminal tickets that are old enough", () => {
  const s = setup();
  s.transcript("OLD-1");
  s.retention.markTerminal("OLD-1");
  s.clock.advance(31 * DAY);
  const fresh = s.transcript("NEW-1");
  s.retention.markTerminal("NEW-1");
  assert.deepEqual(s.retention.prune(), ["OLD-1"]);
  assert.ok(existsSync(fresh));
});

test("decision logs are never pruned", () => {
  const s = setup();
  const log = new DecisionLog(s.dir, s.clock, () => "id-1");
  log.append("ABT-5", { run: "r", node: null, kind: "override", decision: "d", why: "w", evidence: null, result: "ok", payload: { target: "t", by: "runner" } });
  s.transcript("ABT-5");
  s.retention.markTerminal("ABT-5");
  s.clock.advance(365 * DAY);
  assert.deepEqual(s.retention.prune(), ["ABT-5"]);
  assert.equal(log.read("ABT-5").length, 1);
});

test("a runs folder that does not exist yet prunes nothing", () => {
  assert.deepEqual(setup().retention.prune(), []);
});

test("a ticket id that could escape the runs folder is refused", () => {
  const s = setup();
  assert.throws(() => s.retention.markTerminal("../x"));
});

test("the daemon starts the clock when a ticket is Done, restarts it if the ticket is active again, and prunes on the scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abt-ret-"));
  let m!: ReturnType<typeof machine>;
  const retention = new TranscriptRetention({ runsDir: join(dir, "runs"), clock: { now: () => m.clock.now() } });
  m = machine({}, { retention });
  const runner = m.runner();
  const transcripts = (id: string) => {
    mkdirSync(join(dir, "runs", id), { recursive: true });
    writeFileSync(join(dir, "runs", id, "implement-s1.jsonl"), "{}\n");
    return join(dir, "runs", id, "implement-s1.jsonl");
  };
  const done = await m.ticket();
  const active = await m.ticket();
  const doneFile = transcripts(done);
  const activeFile = transcripts(active);
  await m.tracker.setState(done, "Done");
  await m.tracker.setState(active, "In progress");
  await runner.start();
  await runner.idle();
  // Boot's scan stamped the Done ticket and left the active one alone.
  assert.ok(retention.tickets().find((t) => t.ticket === done)?.since);
  assert.equal(retention.tickets().find((t) => t.ticket === active)?.since, undefined);
  m.clock.advance(29 * DAY);
  await runner.idle();
  assert.ok(existsSync(doneFile));
  m.clock.advance(2 * DAY);
  await runner.idle();
  await until(async () => !existsSync(doneFile));
  assert.ok(existsSync(activeFile));
  await runner.stop();
});
