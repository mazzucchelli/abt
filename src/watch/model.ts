import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTree, type TreeNode } from "../tree.ts";
import { DirTrees, LayeredTrees, type TreeStore } from "../trees.ts";
import { isDecisionRecord, ofKind, type DecisionRecord, type NodeOutcomeRecord } from "../log/record.ts";
import type { WorkType } from "../tracker/contract.ts";

/**
 * Everything `abt watch` shows, derived from the decision log and the worker transcripts. This module only
 * reads: it never writes to the log, the tracker or a worker.
 */

export type Status = "ok" | "skip" | "fail" | "todo" | "run" | "wait" | "esc" | "error";
export type Phase = "needs" | "running" | "waiting" | "merged" | "done" | "abandoned";
export type Icon = "ok" | "tx" | "warn" | "esc" | "decided" | "fail" | "info" | "skip" | "end";

export const ACTIVE: readonly Phase[] = ["needs", "running"];
export const FINAL: readonly Phase[] = ["merged", "done", "abandoned"];

export interface TreeRow {
  depth: number;
  name: string;
  status: Status;
  text: string;
  /** Whether it is the stage the ticket is at. */
  current: boolean;
}

export interface Stage {
  name: string;
  status: Status;
}

export interface EventRow {
  at: number;
  icon: Icon;
  node: string;
  text: string;
}

export interface Question {
  question: string;
  recommended: string;
  reversible: boolean;
}

export interface TicketView {
  key: string;
  workType: WorkType;
  phase: Phase;
  risk?: string;
  grade?: string;
  model?: string;
  effort?: string;
  tries: number;
  capMinutes: number;
  startedAt: number;
  /** Last log record or transcript event. */
  lastAt: number;
  elapsedMs: number;
  cost?: number;
  tokensK?: number;
  branch?: string;
  pr?: string;
  question?: Question;
  stages: Stage[];
  /** The nested tree, with the current stage expanded. */
  board: TreeRow[];
  /** The nested tree, with every stage that is under way expanded. */
  full: TreeRow[];
  events: EventRow[];
  /** Latest worker activity from the transcript, when it is newer than the log. */
  activity?: string;
}

export interface Snapshot {
  now: number;
  tickets: TicketView[];
}

export interface LoadOptions {
  home: string;
  runsDir: string;
  now: number;
  /** Where the default trees live; project trees are not visible from here. */
  trees?: TreeStore;
  wallClockMinutes?: Record<string, number>;
}

const DEFAULT_TREES = new DirTrees(fileURLToPath(new URL("../../defaults/trees/", import.meta.url)));
const DEFAULT_CAPS: Record<string, number> = { simple: 45, standard: 90, hard: 180 };
const RESETS = new Set(["escalation", "run", "risk", "ticket"]);
/** A worker with no sign of life for this long is not shown as running. */
const STALE_MS = 30 * 60_000;

function readLog(file: string): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const record: unknown = JSON.parse(l);
      if (isDecisionRecord(record)) out.push(record);
    } catch {
      // a torn last line while the runner is appending
    }
  }
  return out;
}

interface TxEvent {
  at: number;
  icon: Icon;
  text: string;
  cost?: number;
  tokens?: number;
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const short = (p: string) => p.split("/").slice(-3).join("/");

function describeTool(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === "string" ? short(input.file_path) : typeof input.path === "string" ? short(input.path) : undefined;
  if (name === "Bash") return `run ${String(input.command ?? "").split("\n")[0]}`;
  if (file) return `${name.toLowerCase()} ${file}`;
  return name.toLowerCase();
}

/** One worker transcript (stream-json): tool calls and the final result. A file written without stamps takes its modification time. */
function readTranscript(file: string): TxEvent[] {
  const fallback = statSync(file).mtimeMs;
  const out: TxEvent[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const at = typeof e.abt_ts === "string" ? Date.parse(e.abt_ts) : fallback;
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === "tool_use" && typeof c.name === "string") out.push({ at, icon: "tx", text: describeTool(c.name, c.input ?? {}) });
      }
    } else if (e.type === "result") {
      const tokens = (Number(e.usage?.input_tokens) || 0) + (Number(e.usage?.output_tokens) || 0);
      out.push({
        at, icon: e.is_error ? "fail" : "ok", text: e.is_error ? `worker ended with ${e.subtype ?? "an error"}` : "worker finished",
        ...(typeof e.total_cost_usd === "number" && { cost: e.total_cost_usd }), ...(tokens > 0 && { tokens }),
      });
    }
  }
  return out;
}

/** The label of a node on the stepper: the agent it runs, else the last action, else the first leaf. */
function label(n: TreeNode): string {
  const leaves: Extract<TreeNode, { name: string }>[] = [];
  const walk = (x: TreeNode) => ("children" in x ? x.children.forEach(walk) : leaves.push(x));
  walk(n);
  return (leaves.find((l) => l.kind === "agent") ?? leaves.findLast((l) => l.kind === "action") ?? leaves[0])?.name ?? n.id;
}

function nodeText(n: TreeNode): string {
  if ("name" in n) return `${n.kind} ${n.name}`;
  return n.kind === "retry" ? `retry ${n.max}` : n.kind === "timeout" ? `timeout ${n.duration}` : n.kind;
}

const STATUS: Record<string, Status> = { ok: "ok", skipped: "skip", fail: "fail", running: "run", inconclusive: "wait", open: "wait", error: "error" };

async function loadTree(name: string, trees: TreeStore): Promise<TreeNode | undefined> {
  try {
    const t = await trees.read(name);
    return t ? await parseTree(t.source, t.file, trees) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadSnapshot(o: LoadOptions): Promise<Snapshot> {
  const dir = join(o.home, "log");
  const keys = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length)) : [];
  const trees = o.trees ?? DEFAULT_TREES;
  const tickets: TicketView[] = [];
  const cache = new Map<string, Promise<TreeNode | undefined>>();
  const tree = (name: string) => cache.get(name) ?? cache.set(name, loadTree(name, new LayeredTrees(trees, trees))).get(name)!;
  for (const key of keys) {
    const records = readLog(join(dir, `${key}.jsonl`));
    if (records.length === 0) continue;
    const transcripts = jsonlFiles(join(o.runsDir, key)).flatMap(readTranscript).sort((a, b) => a.at - b.at);
    const workType = workTypeOf(records);
    tickets.push(deriveTicket(key, workType, records, transcripts, {
      now: o.now, caps: { ...DEFAULT_CAPS, ...o.wallClockMinutes },
      work: await tree(workType), claim: await tree("claim"), land: await tree("land"), cleanup: await tree("cleanup"),
    }));
  }
  return { now: o.now, tickets };
}

/** An override's value is free-form; an abandon command carries `{ command: "abandon" }`. */
const isAbandon = (v: unknown): boolean => typeof v === "object" && v !== null && "command" in v && v.command === "abandon";

function workTypeOf(records: DecisionRecord[]): WorkType {
  const retyped = ofKind(records, "retype").at(-1)?.payload.to;
  const assessed = ofKind(records, "risk-assessment").findLast((r) => r.payload.workType !== undefined)?.payload.workType;
  return retyped ?? assessed ?? "implement";
}

interface Ctx {
  now: number;
  caps: Record<string, number>;
  work?: TreeNode | undefined;
  claim?: TreeNode | undefined;
  land?: TreeNode | undefined;
  cleanup?: TreeNode | undefined;
}

function deriveTicket(key: string, workType: WorkType, records: DecisionRecord[], tx: TxEvent[], c: Ctx): TicketView {
  const at = (r: DecisionRecord) => Date.parse(r.timestamp);
  const superseded = new Set(records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  const latest = new Map<string, NodeOutcomeRecord>();
  for (const r of records) if (r.kind === "node-outcome" && r.node && !superseded.has(r.id)) latest.set(r.node, r);

  // Phase
  const escIdx = records.findLastIndex((r) => r.kind === "escalation");
  const reset = (from: number) => records.findIndex((r, i) => i > from && r.kind === "override" && RESETS.has(String(r.payload.target)));
  const abandoned = records.some((r) => r.kind === "override" && r.payload.target === "ticket" && isAbandon(r.payload.value));
  const merged = records.some((r) => r.kind === "merge" && r.result === "ok");
  // Cleanup is its own tree for an implement ticket and the work tree's last step for a research one.
  const lastStep = c.work && "children" in c.work ? c.work.children.at(-1) : undefined;
  const cleaned = latest.get("cleanup")?.result === "ok" || (lastStep && "name" in lastStep && lastStep.name === "cleanup" && latest.get(lastStep.id)?.result === "ok");
  const needs = escIdx >= 0 && reset(escIdx) < 0;
  const lastAt = Math.max(at(records.at(-1)!), tx.at(-1)?.at ?? 0);
  const worker = [...latest.values()].find((r) => r.payload.nodeKind === "agent" && r.result === "running");
  let phase: Phase;
  if (merged) phase = "merged";
  else if (abandoned) phase = "abandoned";
  else if (needs) phase = "needs";
  else if (cleaned && workType !== "implement") phase = "done";
  else if (worker && c.now - lastAt < STALE_MS) phase = "running";
  else phase = "waiting";

  const status = (n: TreeNode): Status => STATUS[latest.get(n.id)?.result ?? ""] ?? "todo";
  // A composite's own why only restates its children; leaves say what happened.
  const why = (n: TreeNode) => ("children" in n ? "" : latest.get(n.id)?.why ?? "");

  // Stages: assess, claim, the work tree's top-level steps, then land and cleanup for an implement ticket.
  type Stg = { name: string; status: Status; node?: TreeNode };
  const stages: Stg[] = [{ name: "assess", status: records.some((r) => r.kind === "risk-assessment") ? "ok" : "todo" }];
  if (c.claim) stages.push({ name: "claim", status: status(c.claim), node: c.claim });
  const top = c.work && "children" in c.work ? c.work.children : [];
  for (const n of top) stages.push({ name: label(n), status: status(n), node: n });
  if (workType === "implement") {
    // The work tree's own last step is `land`; the land tree behind it carries the real outcome.
    if (c.land) {
      const i = stages.findLastIndex((s) => s.name === "land");
      const landed = { name: "land", status: merged ? "ok" as Status : status(c.land), node: c.land };
      if (i >= 0) stages[i] = landed; else stages.push(landed);
    }
    if (c.cleanup) stages.push({ name: "cleanup", status: status(c.cleanup), node: c.cleanup });
  }
  if (merged || phase === "done") for (const s of stages) if (s.status === "todo") s.status = "skip";
  // The stage holding the escalation or the running worker; else the first that is not finished.
  const focus = needs ? records[escIdx]!.node : worker?.node;
  const inStage = focus ? stages.findIndex((s) => s.node && (focus === s.node.id || focus.startsWith(`${s.node.id}/`))) : -1;
  const curIdx = inStage >= 0 ? inStage : Math.max(0, stages.findIndex((s) => s.status !== "ok" && s.status !== "skip"));
  const done = FINAL.includes(phase);
  const current = done ? undefined : stages[curIdx];
  if (needs && current) current.status = "esc";
  else if (phase === "running" && current && current.status !== "run") current.status = "run";

  // Latest transcript activity counts when it is newer than the last log record of the current worker.
  const lastRecordAt = at(records.at(-1)!);
  const lastTx = tx.findLast((e) => e.icon === "tx");
  const activity = phase === "running" && lastTx && lastTx.at >= lastRecordAt ? lastTx.text : undefined;

  const rows = (expand: (s: Stg) => boolean): TreeRow[] => {
    const out: TreeRow[] = [];
    for (const s of stages) {
      const isCur = s === current;
      out.push({ depth: 0, name: s.name, status: s.status, text: s.status === "esc" ? "waiting for your reply" : s.node ? why(s.node) : "", current: isCur });
      if (s.node && "children" in s.node && expand(s)) walkRows(s.node.children, 1, out, status, why, activity, phase, needs);
    }
    return out;
  };

  // Header facts
  const routing = records.findLast((r) => r.kind === "routing");
  const risk = records.findLast((r) => r.kind === "risk-assessment")?.payload.tier;
  const grade = typeof routing?.payload.grade === "string" ? routing.payload.grade : undefined;
  const start = at(records[0]!);
  const end = done ? lastAt : c.now;
  const sinceOk = records.slice(records.findLastIndex((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent" && r.result === "ok") + 1);
  const tries = sinceOk.filter((r) => r.kind === "routing").length;
  const cost = tx.reduce((a, e) => a + (e.cost ?? 0), 0);
  const tokens = tx.reduce((a, e) => a + (e.tokens ?? 0), 0);
  const escalation = records[escIdx];
  const esc = needs && escalation?.kind === "escalation" ? escalation : undefined;
  const pr = records.map((r) => /\/pull\/(\d+)/.exec(r.evidence ?? "")?.[1]).findLast(Boolean);
  const branch = ofKind(records, "node-outcome").findLast((r) => r.payload.branch !== undefined)?.payload.branch;

  return {
    key, workType, phase, tries, capMinutes: c.caps[grade ?? ""] ?? 90, startedAt: start, lastAt, elapsedMs: Math.max(0, end - start),
    ...(typeof risk === "string" && { risk }), ...(grade && { grade }),
    ...(typeof routing?.payload.model === "string" && { model: routing.payload.model }),
    ...(typeof routing?.payload.effort === "string" && { effort: routing.payload.effort }),
    ...(cost > 0 && { cost }), ...(tokens > 0 && { tokensK: Math.round(tokens / 1000) }),
    ...(branch && { branch }), ...(pr && { pr: `#${pr}` }),
    ...(esc && { question: { question: esc.payload.question ?? esc.why, recommended: esc.payload.recommended ?? "", reversible: esc.payload.reversible !== false } }),
    stages: stages.map(({ name, status }) => ({ name, status })),
    board: rows((s) => s === current && ACTIVE.includes(phase)),
    full: rows((s) => s.status !== "todo" && s.status !== "ok" && s.status !== "skip"),
    events: events(records, tx, superseded),
    ...(activity && { activity }),
  };
}

function walkRows(nodes: TreeNode[], depth: number, out: TreeRow[], status: (n: TreeNode) => Status, why: (n: TreeNode) => string, activity: string | undefined, phase: Phase, needs: boolean): void {
  for (const n of nodes) {
    let st = status(n);
    let text = why(n);
    if (n.kind === "agent" && st === "run") {
      text = activity ?? text;
      if (needs) st = "esc";
    }
    out.push({ depth, name: nodeText(n), status: st, text, current: false });
    if ("children" in n) walkRows(n.children, depth + 1, out, status, why, activity, phase, needs);
  }
}

const LEAVES = new Set(["check", "judge", "script", "action", "agent"]);

/** The log as a feed: leaf outcomes (repeats collapsed), the decisions and the transcript's tool calls, in time order. */
function events(records: DecisionRecord[], tx: TxEvent[], superseded: Set<string>): EventRow[] {
  const out: EventRow[] = [];
  // A polled check logs the same outcome every pass: show a node's outcome again only when it changes.
  const last = new Map<string, string>();
  for (const r of records) {
    const node = (r.node ?? "").split("/")[0] || r.kind;
    let icon: Icon;
    let text = r.decision;
    if (r.kind === "node-outcome") {
      if (!LEAVES.has(String(r.payload.nodeKind)) || r.result === "skipped") continue;
      icon = r.result === "ok" ? "ok" : r.result === "fail" || r.result === "error" ? "fail" : "info";
      text = r.why && r.result !== "running" ? `${r.payload.name ?? r.decision}: ${r.why}` : r.decision;
      const sig = `${r.result}|${r.why}`;
      if (last.get(String(r.node)) === sig) continue;
      last.set(String(r.node), sig);
    } else if (r.kind === "ask-point") icon = r.payload.handling === "escalated" ? "esc" : "decided";
    else if (r.kind === "escalation") icon = "esc";
    else if (r.kind === "merge") icon = "end";
    else icon = r.result === "fail" ? "fail" : "info";
    if (r.kind === "routing") text = r.decision;
    out.push({ at: Date.parse(r.timestamp), icon, node, text: superseded.has(r.id) ? `${text} (superseded)` : text });
  }
  for (const e of tx) out.push({ at: e.at, icon: e.icon, node: "worker", text: e.text });
  return out.sort((a, b) => a.at - b.at);
}
