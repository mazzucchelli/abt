import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRecord } from "../src/log/record.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "abt-log-"));
  const abt = (args: string[], input?: unknown) =>
    spawnSync("bin/abt", args, {
      encoding: "utf8",
      input: input === undefined ? undefined : JSON.stringify(input),
      env: { ...process.env, ABT_HOME: home },
    });
  const file = (ticket: string) => join(home, "log", `${ticket}.jsonl`);
  return { abt, file };
}

const nodeOutcome = (over: Record<string, unknown> = {}) => ({
  run: "run-1",
  node: "root/0",
  kind: "node-outcome",
  decision: "check branch-up-to-date",
  why: "branch is behind main",
  evidence: null,
  result: "fail",
  payload: { nodeKind: "check" },
  ...over,
});

test("abt log append stamps and appends a valid record as one JSONL line", () => {
  const { abt, file } = setup();
  const r = abt(["log", "append", "T-1"], nodeOutcome());
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(file("T-1"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.ticket, "T-1");
  assert.equal(rec.node, "root/0");
  assert.equal(rec.result, "fail");
  assert.ok(rec.id && rec.timestamp);
});

test("abt log append rejects a record that does not match the schema and writes nothing", () => {
  const { abt, file } = setup();
  const r = abt(["log", "append", "T-1"], nodeOutcome({ result: "maybe" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /result/);
  assert.throws(() => readFileSync(file("T-1")));
});

test("abt log append validates the payload of each record kind", () => {
  const { abt } = setup();
  const good = abt(["log", "append", "T-1"], {
    run: "run-1", node: null, kind: "routing", decision: "route to sonnet", why: "simple grade",
    evidence: null, result: "ok", payload: { grade: "simple", model: "claude-sonnet-5-5", effort: "medium", min_model_from_risk: "claude-sonnet-5-5" },
  });
  assert.equal(good.status, 0, good.stderr);
  const bad = abt(["log", "append", "T-1"], {
    run: "run-1", node: null, kind: "routing", decision: "route", why: "x",
    evidence: null, result: "ok", payload: { grade: "tiny" },
  });
  assert.notEqual(bad.status, 0);
});

test("a wrong record is superseded, never edited", () => {
  const { abt, file } = setup();
  abt(["log", "append", "T-1"], nodeOutcome());
  const first = JSON.parse(readFileSync(file("T-1"), "utf8").trim());
  const r = abt(["log", "append", "T-1"], nodeOutcome({ result: "ok", why: "corrected", supersedes: first.id }));
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(file("T-1"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), first);
  assert.equal(JSON.parse(lines[1]!).supersedes, first.id);
});

test("abt log append refuses to supersede a record that does not exist", () => {
  const { abt } = setup();
  const r = abt(["log", "append", "T-1"], nodeOutcome({ supersedes: "nope" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nope/);
});

test("abt log show prints a run as a table and marks superseded records", () => {
  const { abt, file } = setup();
  abt(["log", "append", "T-1"], nodeOutcome());
  const first = JSON.parse(readFileSync(file("T-1"), "utf8").trim());
  abt(["log", "append", "T-1"], nodeOutcome({ node: "root/1", result: "ok", why: "fine", supersedes: first.id }));
  abt(["log", "append", "T-1"], nodeOutcome({ run: "run-2", node: "other", why: "other run" }));
  const r = abt(["log", "show", "T-1", "--run", "run-1"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trimEnd().split("\n");
  assert.match(rows[0]!, /^TIME\s+NODE\s+KIND\s+RESULT\s+DECISION\s+WHY\s+NOTE$/);
  assert.equal(rows.length, 3);
  assert.match(rows[1]!, /root\/0\s+node-outcome\s+fail\s+check branch-up-to-date\s+branch is behind main\s+superseded/);
  assert.match(rows[2]!, /root\/1\s+node-outcome\s+ok/);
  assert.doesNotMatch(r.stdout, /other run/);
});

test("abt log show defaults to the latest run", () => {
  const { abt } = setup();
  abt(["log", "append", "T-1"], nodeOutcome({ why: "old run" }));
  abt(["log", "append", "T-1"], nodeOutcome({ run: "run-2", why: "new run" }));
  const r = abt(["log", "show", "T-1"]);
  assert.match(r.stdout, /new run/);
  assert.doesNotMatch(r.stdout, /old run/);
});

test("abt log show fails for a ticket with no log", () => {
  const { abt } = setup();
  const r = abt(["log", "show", "T-9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /T-9/);
});

test("a worker may append ask-point, pivot and blocked records only", () => {
  const { abt, file } = setup();
  const worker = (args: string[], input: unknown) => {
    const home = file("X").replace(/\/log\/X\.jsonl$/, "");
    return spawnSync("bin/abt", args, {
      encoding: "utf8",
      input: JSON.stringify(input),
      env: { ...process.env, ABT_HOME: home, ABT_ROLE: "worker", ABT_TICKET: "T-1" },
    });
  };
  const ask = nodeOutcome({
    kind: "ask-point", decision: "which db", result: "open",
    payload: { question: "q", recommended: "r", reversible: true },
  });
  assert.equal(worker(["log", "append", "T-1"], ask).status, 0);
  const pivot = nodeOutcome({ kind: "pivot", decision: "switch", result: "ok", payload: { from: "a", to: "b", trigger: "t" } });
  assert.equal(worker(["log", "append", "T-1"], pivot).status, 0);

  const refused = worker(["log", "append", "T-1"], nodeOutcome());
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /workers may only write ask-point, pivot and blocked/);
  assert.equal(readFileSync(file("T-1"), "utf8").trim().split("\n").length, 2);

  const other = worker(["log", "append", "T-2"], ask);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /T-1/);
  assert.equal(abt(["log", "append", "T-3"], nodeOutcome()).status, 0, "without the worker role any kind is accepted");
});

test("a worker may send raisesTo with its open ask-point", () => {
  const { file } = setup();
  const home = file("X").replace(/\/log\/X\.jsonl$/, "");
  const r = spawnSync("bin/abt", ["log", "append", "T-1"], {
    encoding: "utf8",
    input: JSON.stringify(nodeOutcome({ kind: "ask-point", decision: "d", result: "open", payload: { question: "q", recommended: "r", reversible: true, raisesTo: "high" } })),
    env: { ...process.env, ABT_HOME: home, ABT_ROLE: "worker", ABT_TICKET: "T-1" },
  });
  assert.equal(r.status, 0, r.stderr);
});

test("a worker cannot settle its own ask-point: handling or a non-open result is refused", () => {
  const { file } = setup();
  const worker = (input: unknown) => {
    const home = file("X").replace(/\/log\/X\.jsonl$/, "");
    return spawnSync("bin/abt", ["log", "append", "T-1"], {
      encoding: "utf8",
      input: JSON.stringify(input),
      env: { ...process.env, ABT_HOME: home, ABT_ROLE: "worker", ABT_TICKET: "T-1" },
    });
  };
  const payload = { question: "q", recommended: "r", reversible: true };
  for (const handling of ["decided", "escalated"]) {
    const r = worker(nodeOutcome({ kind: "ask-point", decision: "d", result: "open", payload: { ...payload, handling } }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handling/);
  }
  const raises = worker(nodeOutcome({ kind: "ask-point", decision: "d", result: "open", payload: { ...payload, raisesTo: "extreme" } }));
  assert.equal(raises.status, 1, "raisesTo must be a tier");
  const settled = worker(nodeOutcome({ kind: "ask-point", decision: "d", result: "ok", payload }));
  assert.equal(settled.status, 1);
  assert.match(settled.stderr, /open/);
  const { result: _omitted, ...noResult } = nodeOutcome({ kind: "ask-point", decision: "d", payload }) as Record<string, unknown>;
  assert.equal(worker(noResult).status, 1, "a missing result is not open");
  assert.equal(worker(nodeOutcome({ kind: "ask-point", decision: "d", result: "open", payload: null })).status, 1);
  assert.equal(existsSync(file("T-1")), false, "nothing was written");
});

test("a worker marks its ticket blocked with abt log append", () => {
  const { file } = setup();
  const abt = (args: string[], input: unknown) =>
    spawnSync("bin/abt", args, {
      encoding: "utf8",
      input: JSON.stringify(input),
      env: { ...process.env, ABT_HOME: file("X").replace(/\/log\/X\.jsonl$/, ""), ABT_ROLE: "worker", ABT_TICKET: "T-1" },
    });
  const r = abt(["log", "append", "T-1"], {
    run: "run-1", node: null, kind: "blocked", decision: "blocked by T-2", why: "needs T-2's API first",
    evidence: null, result: "ok", payload: { by: ["T-2"] },
  });
  assert.equal(r.status, 0, r.stderr);
  const empty = abt(["log", "append", "T-1"], {
    run: "run-1", node: null, kind: "blocked", decision: "blocked", why: "x", evidence: null, result: "ok", payload: { by: [] },
  });
  assert.notEqual(empty.status, 0);
});

test("a worker's retype is refused and turned into an escalated ask-point", () => {
  const { file } = setup();
  const worker = spawnSync("bin/abt", ["log", "append", "T-1"], {
    encoding: "utf8",
    input: JSON.stringify({
      run: "run-1", node: "implement/0", kind: "retype", decision: "retyped implement to research", why: "this is a question, not a change",
      evidence: null, result: "ok", payload: { by: "worker", from: "implement", to: "research" },
    }),
    env: { ...process.env, ABT_HOME: file("X").replace(/\/log\/X\.jsonl$/, ""), ABT_ROLE: "worker", ABT_TICKET: "T-1" },
  });
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /only the owner can retype/);
  const records = readFileSync(file("T-1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 1, "the retype itself is not recorded");
  assert.equal(records[0].kind, "ask-point");
  assert.equal(records[0].run, "run-1");
  assert.equal(records[0].result, "open");
  assert.equal(records[0].payload.handling, "escalated");
  assert.equal(records[0].payload.reversible, false);
  assert.equal(records[0].payload.retype, "research");
  assert.match(records[0].payload.question, /research/);
});

test("an ask-point a worker raises is open and carries no handling; a settled one must say how it was handled", () => {
  const raised = { ...nodeOutcome(), kind: "ask-point", decision: "which db", result: "open", payload: { question: "q", recommended: "r", reversible: true } };
  assert.deepEqual(validateRecord({ ...raised, id: "a", timestamp: "2026-01-01T00:00:00Z", ticket: "T-1" }), []);
  const settled = { ...raised, result: "ok", id: "b", timestamp: "2026-01-01T00:00:00Z", ticket: "T-1" };
  assert.ok(validateRecord(settled).some((p) => /handling/.test(p)));
});
