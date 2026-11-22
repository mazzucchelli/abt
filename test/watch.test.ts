import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { loadSnapshot } from "../src/watch/model.ts";
import { render, type Ui } from "../src/watch/render.ts";
import { reduce } from "../src/watch/keys.ts";

const HOME = "test/fixtures/watch/home";
const RUNS = "test/fixtures/watch/runs";
// 09:40 UTC on the fixtures' day: ABT-201's worker is mid-run.
const NOW = Date.UTC(2026, 10, 22, 9, 40, 0);

const snapshot = () => loadSnapshot({ home: HOME, runsDir: RUNS, now: NOW });
const frame = async (ui: Partial<Ui> = {}, size = { width: 140, height: 44 }) =>
  render(await snapshot(), { sel: "BOARD", scroll: 0, paused: false, ...ui }, { ...size, now: NOW, color: false, utc: true }).join("\n");

test("the board shows every active ticket as a card: header, tree with node status, live log and meter footer", async () => {
  const f = await frame();
  assert.match(f, /RUNNING\s+ABT-201/);
  assert.match(f, /NEEDS YOU\s+ABT-202/);
  assert.doesNotMatch(f, /MERGED\s+ABT-203/); // finished tickets are not cards
  assert.doesNotMatch(f, /WAITING\s+ABT-206/); // nor are tickets that only wait on CI
  // header: risk, grade and the model the router chose
  assert.match(f, /risk low\s+·\s+implement/);
  assert.match(f, /simple\s+·\s+claude-sonnet-5-5 medium/);
  // tree: finished stages ticked, the current stage expanded down to the agent with its latest activity
  assert.match(f, /✓ claim/);
  assert.match(f, /agent tdd\s+.*run npm test -- copy/);
  // log: transcript events come from the worker's stream, newest last
  assert.match(f, /09:37 .*edit src\/lib\/copy\.ts/);
  // footer: time against the grade's cap, tries, cost from the transcripts
  assert.match(f, /time .* 40\/45m/);
  assert.match(f, /tries 2/);
  assert.match(f, /cost \$0\.48\s+·\s+131k tok/);
  assert.match(f, /⎇ feature\/abt-201-meal-copy/);
});

test("the sidebar lists the live summary, Board first, then every ticket, finished ones included", async () => {
  const f = await frame();
  const side = f.split("\n").map((l) => l.split("│")[0]!).join("\n");
  assert.match(side, /workers 1\s+needs 1\s+waiting 1/);
  assert.ok(side.indexOf("Board") < side.indexOf("ABT-202"));
  assert.ok(side.indexOf("ABT-202") < side.indexOf("ABT-201"), "needs you sorts before running");
  assert.match(side, /ABT-203\s+merged/);
  assert.match(side, /ABT-204\s+abandoned/);
});

test("an escalated ticket shows its question, the recommendation and how to reply, above the tree and log", async () => {
  const f = await frame({ sel: "ABT-202" });
  assert.match(f, /QUESTION FOR YOU/);
  assert.match(f, /Merge duplicate pantry items/);
  assert.match(f, /recommends\s+No: keep both rows/);
  assert.match(f, /irreversible/);
  assert.match(f, /yes\s+takes the recommendation/);
  assert.match(f, /answer: <text>/);
  assert.match(f, /abandon\s+·\s+re-run\s+·\s+raise tier/);
  assert.match(f, /waiting for your reply/);
  assert.ok(f.indexOf("QUESTION FOR YOU") < f.indexOf("implement.yaml"));
});

test("a ticket view has a stepper, the full tree beside a full log, and a footer", async () => {
  const f = await frame({ sel: "ABT-201" });
  assert.match(f, /assess\s+claim\s+spec-writ.*await-spec.*tdd\s+open-pr\s+land\s+cleanup/);
  assert.match(f, /└─ .*agent tdd/);
  assert.match(f, /09:04  › route simple to claude-sonnet-5-5 at medium/);
  assert.match(f, /09:17  ✕ tdd: worker ended with error/);
  assert.match(f, /cost \$0\.48/);
  assert.doesNotMatch(f, /QUESTION FOR YOU/);
});

test("a finished ticket stays viewable with its outcome", async () => {
  const merged = await frame({ sel: "ABT-203" });
  assert.match(merged, /MERGED\s+ABT-203/);
  assert.match(merged, /PR #85/);
  assert.match(merged, /■ .*runner merged the PR/);
  const gone = await frame({ sel: "ABT-204" });
  assert.match(gone, /ABANDONED\s+ABT-204/);
  assert.match(gone, /owner abandoned the ticket/);
  assert.doesNotMatch(gone, /QUESTION FOR YOU/, "an answered escalation no longer asks");
});

test("scrolling the log back pauses following and says how much is hidden", async () => {
  const live = await frame({ sel: "ABT-201" }, { width: 140, height: 24 });
  assert.doesNotMatch(live, /following paused/);
  const back = await frame({ sel: "ABT-201", scroll: 3 }, { width: 140, height: 24 });
  assert.match(back, /following paused/);
  assert.match(back, /↑ \d+ earlier/);
});

test("a narrow terminal drops the sidebar but still renders every line within its width", async () => {
  const lines = render(await snapshot(), { sel: "BOARD", scroll: 0, paused: false }, { width: 70, height: 30, now: NOW, color: false, utc: true });
  assert.equal(lines.length, 30);
  assert.ok(lines.every((l) => [...l].length <= 70));
  assert.doesNotMatch(lines.join("\n"), /FINISHED/);
});

test("colour is only emitted when asked for", async () => {
  const s = await snapshot();
  const plain = render(s, { sel: "BOARD", scroll: 0, paused: false }, { width: 120, height: 30, now: NOW, color: false }).join("");
  const coloured = render(s, { sel: "BOARD", scroll: 0, paused: false }, { width: 120, height: 30, now: NOW, color: true }).join("");
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(coloured, /\x1b\[/);
});

test("keys: up/down navigate Board then tickets, b returns to the board, j/k scroll the log, space pauses, q quits", async () => {
  const s = await snapshot();
  const start: Ui = { sel: "BOARD", scroll: 0, paused: false };
  const down = reduce(start, "\x1b[B", s) as Ui;
  assert.equal(down.sel, "ABT-202"); // needs you first
  assert.equal((reduce(down, "\x1b[B", s) as Ui).sel, "ABT-201");
  assert.equal((reduce(start, "\x1b[A", s) as Ui).sel, "ABT-204", "up from the board wraps to the last ticket");
  const back = reduce({ ...down, scroll: 4 }, "b", s) as Ui;
  assert.deepEqual([back.sel, back.scroll], ["BOARD", 0]);
  assert.equal((reduce(down, "k", s) as Ui).scroll, 1);
  assert.equal((reduce(down, "j", s) as Ui).scroll, 0, "j never goes below the newest line");
  assert.equal((reduce({ ...down, scroll: 2 }, "\x1b[B", s) as Ui).scroll, 0, "moving to another ticket resets the scroll");
  assert.equal((reduce(start, " ", s) as Ui).paused, true);
  assert.equal(reduce(start, "q", s), "quit");
  assert.equal(reduce(start, "\x03", s), "quit");
  assert.deepEqual(reduce(start, "x", s), start);
});

test("abt watch --once prints one frame from the real log folder and never writes to it", () => {
  const before = readdirSync(`${HOME}/log`).map((f) => [f, statSync(`${HOME}/log/${f}`).mtimeMs]);
  const r = spawnSync("bin/abt", ["watch", "--once", "ABT-202"], { encoding: "utf8", env: { ...process.env, ABT_HOME: HOME, ABT_UNPINNED: "1", COLUMNS: "120", LINES: "40" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NEEDS YOU\s+ABT-202/);
  assert.match(r.stdout, /QUESTION FOR YOU/);
  assert.deepEqual(readdirSync(`${HOME}/log`).map((f) => [f, statSync(`${HOME}/log/${f}`).mtimeMs]), before);
});

test("abt watch refuses to run without a terminal", () => {
  const r = spawnSync("bin/abt", ["watch"], { encoding: "utf8", env: { ...process.env, ABT_HOME: HOME, ABT_UNPINNED: "1" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a terminal/);
});

test("a research ticket whose cleanup step is done counts as done, and a polled check is logged once", async () => {
  assert.match(await frame(), /ABT-205\s+done/);
  const f = await frame({ sel: "ABT-206" });
  assert.match(f, /WAITING\s+ABT-206/);
  assert.equal(f.match(/ci-check-green: required check/g)?.length, 1, "three polls, one line");
  assert.match(f, /PR #90/);
});

test("a terminal too small to draw in gets a plain message instead of a crash", async () => {
  const lines = render(await snapshot(), { sel: "BOARD", scroll: 0, paused: false }, { width: 10, height: 5, now: NOW, color: false });
  assert.match(lines.join(""), /too small/);
});
