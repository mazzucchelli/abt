import { ACTIVE, FINAL, type EventRow, type Icon, type Phase, type Snapshot, type Status, type TicketView, type TreeRow } from "./model.ts";

/**
 * The board and ticket views as lines of text. Pure: a snapshot, the UI state and a size in, lines out.
 * Nothing here reads a file or the clock, so a frame is the same for the same inputs.
 */

export const BOARD = "BOARD";

export interface Ui {
  /** BOARD or a ticket key. */
  sel: string;
  /** Log lines scrolled up from the newest. */
  scroll: number;
  paused: boolean;
}

export interface Size {
  width: number;
  height: number;
  /** Wall clock in ms: drives the spinner, the pulse and the "new" tags. */
  now: number;
  color: boolean;
  /** Show times in UTC instead of local time. */
  utc?: boolean;
}

type Color = "side" | "line" | "faint" | "muted" | "text" | "bright" | "teal" | "amber" | "rose" | "green" | "blue";
const ANSI: Record<Color, number> = { side: 234, line: 238, faint: 241, muted: 246, text: 252, bright: 255, teal: 44, amber: 214, rose: 204, green: 114, blue: 75 };

interface Seg {
  t: string;
  c?: Color;
  b?: boolean;
  r?: boolean;
}
type Line = Seg[];

const seg = (t: string, c?: Color, b?: boolean): Seg => ({ t, ...(c && { c }), ...(b && { b }) });
const vlen = (l: Line) => l.reduce((n, s) => n + [...s.t].length, 0);

function clip(l: Line, w: number): Line {
  const out: Line = [];
  let left = w;
  for (const s of l) {
    if (left <= 0) break;
    const chars = [...s.t];
    out.push(chars.length <= left ? s : { ...s, t: chars.slice(0, left).join("") });
    left -= Math.min(left, chars.length);
  }
  return out;
}

const pad = (l: Line, w: number): Line => {
  const c = clip(l, w);
  return [...c, seg(" ".repeat(Math.max(0, w - vlen(c))))];
};

function emit(l: Line, color: boolean): string {
  return l.map((s) => (color && (s.c || s.b || s.r) ? `\x1b[${s.b ? "1;" : ""}${s.r ? "7;" : ""}38;5;${ANSI[s.c ?? "text"]}m${s.t}\x1b[0m` : s.t)).join("");
}

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && [...cur].length + 1 + [...word].length > w) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const spinner = (now: number) => SPIN[Math.floor(now / 100) % SPIN.length]!;
const pulsing = (now: number) => Math.floor(now / 500) % 2 === 0;

const PHASE: Record<Phase, { word: string; color: Color }> = {
  needs: { word: "NEEDS YOU", color: "amber" },
  running: { word: "RUNNING", color: "teal" },
  waiting: { word: "WAITING", color: "faint" },
  merged: { word: "MERGED", color: "green" },
  done: { word: "DONE", color: "green" },
  abandoned: { word: "ABANDONED", color: "muted" },
};

const RISK: Record<string, Color> = { low: "green", medium: "amber", high: "rose" };
const EVENT_ICON: Record<Icon, [string, Color]> = {
  tx: ["·", "muted"], warn: ["!", "amber"], esc: ["?", "amber"], decided: ["⚑", "blue"], fail: ["✕", "rose"],
  info: ["›", "teal"], end: ["■", "green"], skip: ["–", "faint"], ok: ["✓", "green"],
};

function glyph(s: Status, now: number): [string, Color] {
  switch (s) {
    case "ok": return ["✓", "green"];
    case "skip": return ["–", "faint"];
    case "fail": return ["✕", "rose"];
    case "error": return ["!", "amber"];
    case "run": return [spinner(now), "teal"];
    case "wait": return ["›", "teal"];
    case "esc": return [pulsing(now) ? "●" : "○", "amber"];
    default: return ["○", "faint"];
  }
}

function clock(ms: number, utc: boolean): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return utc ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const meter = (frac: number, n: number) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return "▰".repeat(k) + "▱".repeat(n - k);
};

/** Every ticket in the order the sidebar lists it: needs you, running, waiting, then finished, newest first. */
export function ordered(s: Snapshot): { live: TicketView[]; past: TicketView[] } {
  const rank: Partial<Record<Phase, number>> = { needs: 0, running: 1, waiting: 2 };
  const live = s.tickets.filter((t) => rank[t.phase] !== undefined).sort((a, b) => rank[a.phase]! - rank[b.phase]! || a.startedAt - b.startedAt);
  const past = s.tickets.filter((t) => FINAL.includes(t.phase)).sort((a, b) => b.lastAt - a.lastAt);
  return { live, past };
}

/** BOARD first, then every ticket in sidebar order. */
export function navOrder(s: Snapshot): string[] {
  const { live, past } = ordered(s);
  return [BOARD, ...live.map((t) => t.key), ...past.map((t) => t.key)];
}

const KEYS = "↑↓ navigate   b board   j/k scroll log   space pause   q quit";

export function render(snap: Snapshot, ui: Ui, size: Size): string[] {
  const { width, height, now } = size;
  if (width < 24 || height < 12) return ["too small"];
  const utc = size.utc ?? false;
  const { live, past } = ordered(snap);
  const order = navOrder(snap);
  const sel = order.includes(ui.sel) ? ui.sel : BOARD;
  const showSide = width >= 90;
  const SB = showSide ? 32 : 0;
  const mx = showSide ? 2 : 0;
  const mw = width - SB - mx - 1;
  const bodyTop = 3;
  const bodyH = height - bodyTop - 1;

  const main: Line[] = [];
  const ticket = snap.tickets.find((t) => t.key === sel);
  const crumbs: Line = ticket
    ? [seg("Board", "muted"), seg("  ›  ", "faint"), seg(ticket.key, "bright", true), seg(`  ${ticket.workType}`, "muted")]
    : [seg("Board", "bright", true), seg("   all active tickets", "muted")];
  main.push([], crumbs.length ? crumbs : []);
  main.push([]);
  if (ticket) main.push(...ticketView(ticket, mw, bodyH, now, ui.scroll, utc));
  else main.push(...board(live.filter((t) => ACTIVE.includes(t.phase)), mw, bodyH, now, utc));
  while (main.length < height - 1) main.push([]);
  main.length = height - 1;
  main.push([seg(KEYS, "faint")]);
  if (ui.paused) main[0] = [seg(" PAUSED ", "amber", true), seg("  updates are frozen; space resumes", "muted")];

  const side = showSide ? sidebar(snap, live, past, sel, height, now) : [];
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    const row: Line = [];
    if (showSide) row.push(...pad(side[y] ?? [], SB), seg("│", "line"), seg(" ".repeat(mx - 1)));
    row.push(...clip(main[y] ?? [], width - SB - mx));
    lines.push(emit(row, size.color).trimEnd());
  }
  return lines;
}

// ---------------------------------------------------------------- sidebar
function sidebar(snap: Snapshot, live: TicketView[], past: TicketView[], sel: string, h: number, now: number): Line[] {
  const L: Line[] = [];
  const inner = 29;
  const running = snap.tickets.filter((t) => t.phase === "running").length;
  const needs = snap.tickets.filter((t) => t.phase === "needs").length;
  const waiting = snap.tickets.filter((t) => t.phase === "waiting").length;
  L.push([]);
  L.push([seg(" ◆ ", "teal", true), seg("abt watch", "bright", true)]);
  L.push([]);
  L.push([seg(" workers ", "muted"), seg(String(running), "teal", true), seg("  needs ", "muted"), seg(String(needs), needs ? "amber" : "faint", true), seg("  waiting ", "muted"), seg(String(waiting), "text", true)]);
  L.push([]);
  const active = live.filter((t) => ACTIVE.includes(t.phase)).length;
  L.push([seg(sel === BOARD ? "▌" : " ", "teal"), seg("▦ ", "teal", true), seg("Board", sel === BOARD ? "bright" : "text", true), seg(`  ${active} active`, "muted")]);
  L.push([]);
  const row = (t: TicketView) => {
    const p = PHASE[t.phase];
    const on = t.key === sel;
    const g: [string, Color] = t.phase === "running" ? [spinner(now), "teal"] : t.phase === "needs" ? [pulsing(now) ? "●" : "○", "amber"]
      : t.phase === "merged" || t.phase === "done" ? ["✓", "green"] : t.phase === "abandoned" ? ["✕", "muted"] : ["○", "faint"];
    L.push([seg(on ? "▌" : " ", p.color), seg(` ${g[0]} `, g[1], true), seg(t.key, on ? "bright" : "text", true), seg(`  ${p.word.toLowerCase()}`, ACTIVE.includes(t.phase) ? p.color : "muted")]);
    const sub = t.activity ?? t.question?.question ?? t.events.findLast((e) => e.icon !== "tx")?.text ?? t.workType;
    L.push([seg("    "), seg([...sub].slice(0, inner - 4).join(""), on ? "text" : "muted")]);
  };
  L.push([seg(" NOW", "faint", true)]);
  if (live.length === 0) L.push([seg("    nothing running", "faint")]);
  live.forEach(row);
  L.push([]);
  L.push([seg(" FINISHED", "faint", true)]);
  if (past.length === 0) L.push([seg("    none yet", "faint")]);
  past.forEach(row);
  while (L.length < h - 2) L.push([]);
  L.length = h - 2;
  L.push([seg(" abt log show <id>", "faint")]);
  return L;
}

// ---------------------------------------------------------------- pieces
function pill(t: TicketView, now: number): Seg {
  const p = PHASE[t.phase];
  return { t: ` ${p.word} `, c: p.color, b: true, r: t.phase !== "needs" || pulsing(now) };
}

function eventLine(e: EventRow, now: number, utc: boolean): Line {
  const [icon, color] = EVENT_ICON[e.icon];
  const fresh = now - e.at < 2000 && now >= e.at;
  const l: Line = [seg(`${clock(e.at, utc)}  `, "faint"), seg(`${icon} `, color, true)];
  l.push(seg(e.text, fresh ? "bright" : e.icon === "tx" ? "muted" : "text", fresh));
  if (fresh) l.push(seg("  new", "green", true));
  return l;
}

function treeLines(rows: TreeRow[], w: number, now: number): Line[] {
  return rows.map((r, i) => {
    const next = rows.slice(i + 1).find((x) => x.depth <= r.depth);
    const last = !next || next.depth < r.depth;
    const branch = r.depth === 0 ? (last ? "└─ " : "├─ ") : `│  ${"   ".repeat(r.depth - 1)}${last ? "└─ " : "├─ "}`;
    const [g, gc] = glyph(r.status, now);
    const name = r.name.padEnd(Math.max(14 - 3 * r.depth, r.name.length + 2));
    const dim = r.status === "todo" || r.status === "skip";
    return clip([
      seg(branch, "line"), seg(`${g} `, gc, true), seg(name, r.current ? "bright" : dim ? "muted" : "text", r.current),
      seg(r.text, r.status === "run" ? "teal" : r.status === "esc" ? "amber" : "muted"),
    ], w);
  });
}

function questionCard(t: TicketView, w: number, now: number): Line[] {
  const q = t.question;
  if (!q) return [];
  const c: Color = pulsing(now) ? "amber" : "faint";
  const L: Line[] = [[seg("QUESTION FOR YOU", "amber", true)]];
  for (const l of wrap(q.question, w - 2)) L.push([seg(l, "bright", true)]);
  const rec = wrap(q.recommended, w - 14);
  rec.forEach((l, i) => L.push([seg(i === 0 ? "recommends  " : "            ", "muted"), seg(l, "text")]));
  L.push([seg(q.reversible ? "reversible" : "irreversible", q.reversible ? "muted" : "rose")]);
  L.push([seg("reply as a comment on the ticket:", "muted")]);
  L.push([seg("yes", "green", true), seg(" takes the recommendation · ", "muted"), seg("answer: <text>", "text", true), seg(" decides otherwise", "muted")]);
  L.push([seg("abandon", "text", true), seg(" · ", "muted"), seg("re-run", "text", true), seg(" · ", "muted"), seg("raise tier", "text", true)]);
  return L.map((l) => [seg("▍ ", c), ...l]);
}

const FOOT = 4;

function footer(t: TicketView, w: number, now: number): Line[] {
  const frac = t.capMinutes ? t.elapsedMs / 60_000 / t.capMinutes : 0;
  const tc: Color = t.phase !== "running" ? "faint" : frac > 0.8 ? "rose" : frac > 0.5 ? "amber" : "teal";
  const mins = Math.floor(t.elapsedMs / 60_000);
  const L: Line[] = [[seg("─".repeat(w), "line")]];
  L.push([
    seg("time ", "muted"), seg(meter(frac, Math.max(6, Math.min(16, w - 34))), tc), seg(` ${mins}/${t.capMinutes}m`, "muted"),
    seg("   tries ", "muted"), seg(`${t.tries} `, "muted"), seg("●".repeat(t.tries), t.tries > 1 ? "amber" : "teal", true),
  ]);
  L.push([
    seg("cost ", "muted"), seg(t.cost !== undefined ? `$${t.cost.toFixed(2)}` : "$ –", "text", true),
    ...(t.tokensK !== undefined ? [seg("  ·  ", "line"), seg(`${t.tokensK}k tok`, "muted")] : []),
  ]);
  const refs: Line = [];
  if (t.branch) refs.push(seg(`⎇ ${t.branch}`, "muted"), seg("   "));
  if (t.pr) refs.push(seg(`PR ${t.pr}`, "blue"));
  L.push(refs);
  return L;
}

function box(inner: Line[], w: number, h: number, color: Color, bold: boolean): Line[] {
  const iw = w - 4;
  const out: Line[] = [[seg(`╭${"─".repeat(w - 2)}╮`, color, bold)]];
  for (let i = 0; i < h - 2; i++) out.push([seg("│ ", color, bold), ...pad(inner[i] ?? [], iw), seg(" │", color, bold)]);
  out.push([seg(`╰${"─".repeat(w - 2)}╯`, color, bold)]);
  return out;
}

const borderOf = (t: TicketView, now: number): [Color, boolean] =>
  t.phase === "needs" ? ["amber", pulsing(now)] : [PHASE[t.phase].color, false];

// ---------------------------------------------------------------- board
function board(active: TicketView[], w: number, h: number, now: number, utc: boolean): Line[] {
  if (active.length === 0) return [[seg("No active tickets. Queued work starts when a worker slot frees up.", "muted")]];
  const cols = Math.max(1, Math.min(active.length, Math.floor(w / 46)));
  const rows = Math.ceil(active.length / cols);
  const cw = Math.floor((w - (cols - 1)) / cols);
  const ch = Math.floor(h / rows);
  const out: Line[] = [];
  for (let r = 0; r < rows; r++) {
    const cards = active.slice(r * cols, (r + 1) * cols).map((t) => card(t, cw, ch, now, utc));
    for (let y = 0; y < ch; y++) out.push(cards.flatMap((c, i) => [...(i ? [seg(" ")] : []), ...pad(c[y] ?? [], cw)]));
  }
  return out;
}

function card(t: TicketView, w: number, h: number, now: number, utc: boolean): Line[] {
  const iw = w - 4;
  const head: Line[] = [
    [pill(t, now), seg(` ${t.key}`, "bright", true)],
    [seg("risk ", "muted"), seg(t.risk ?? "?", RISK[t.risk ?? ""] ?? "muted", true), seg("  ·  ", "line"), seg(t.workType, "text")],
  ];
  if (t.grade) head.push([seg(t.grade, "text"), seg(t.model ? `  ·  ${t.model}${t.effort ? ` ${t.effort}` : ""}` : "", "muted")]);
  head.push([]);
  const body: Line[] = [...head, ...questionCard(t, iw, now)];
  if (t.question) body.push([]);
  body.push([seg(`${t.workType}.yaml`, "faint")]);
  body.push(...treeLines(t.board, iw, now));
  body.push([]);
  const foot = footer(t, iw, now);
  const room = h - 2 - FOOT - body.length - 1;
  const inner = [...body];
  if (room >= 2) {
    inner.push([seg("log", "faint")]);
    const evs = t.events.slice(-(room - 1));
    for (const e of evs) inner.push(eventLine(e, now, utc));
  }
  const space = h - 2 - foot.length;
  const padded = inner.slice(0, space);
  while (padded.length < space) padded.push([]);
  const [bc, bold] = borderOf(t, now);
  return box([...padded, ...foot], w, h, bc, bold);
}

// ---------------------------------------------------------------- ticket
function stepper(t: TicketView, w: number, now: number): Line[] {
  const n = t.stages.length;
  if (n === 0) return [];
  const sw = Math.max(8, Math.min(22, Math.floor(w / n)));
  const top: Line = [];
  const bottom: Line = [];
  t.stages.forEach((s, i) => {
    const done = s.status === "ok" || s.status === "skip";
    const [g, c]: [string, Color] = s.status === "ok" ? ["●", "green"] : s.status === "skip" ? ["◌", "faint"] : s.status === "fail" || s.status === "error" ? ["✕", "rose"]
      : s.status === "esc" ? [pulsing(now) ? "◉" : "○", "amber"] : s.status === "run" || s.status === "wait" ? ["◉", "teal"] : ["○", "faint"];
    top.push(seg(g, c, true));
    if (i < n - 1) top.push(seg((done ? "━" : "┄").repeat(sw - 1), done ? "green" : "line"));
    const cur = s.status === "run" || s.status === "esc" || s.status === "wait";
    const nm = [...s.name].length > sw - 1 ? `${[...s.name].slice(0, sw - 2).join("")}…` : s.name;
    bottom.push(seg(nm.padEnd(sw), cur ? "bright" : s.status === "todo" ? "faint" : "muted", cur));
  });
  return [top, bottom];
}

function ticketView(t: TicketView, w: number, h: number, now: number, scroll: number, utc: boolean): Line[] {
  const iw = w - 4;
  const head: Line[] = [
    [pill(t, now), seg(`  ${t.key}`, "bright", true)],
    [
      seg("risk ", "muted"), seg(t.risk ?? "?", RISK[t.risk ?? ""] ?? "muted", true), seg("  ·  ", "line"), seg(t.workType, "text"),
      ...(t.grade ? [seg("  ·  ", "line"), seg(t.grade, "text"), seg(t.model ? ` (${t.model}${t.effort ? ` ${t.effort}` : ""})` : "", "muted")] : []),
    ],
    [],
    ...stepper(t, iw, now),
    [],
    ...questionCard(t, iw, now),
    ...(t.question ? [[]] : []),
  ];
  const foot = footer(t, iw, now);
  const room = Math.max(1, h - 2 - foot.length - head.length - 1);
  const left = Math.min(56, Math.floor(iw * 0.46));
  const rw = iw - left - 2;
  const tree = treeLines(t.full, left - 2, now);
  const maxScroll = Math.max(0, t.events.length - room);
  const sc = Math.min(scroll, maxScroll);
  const start = Math.max(0, maxScroll - sc);
  const evs = t.events.slice(start, start + room);
  const rowsOut: Line[] = [];
  const logHead: Line = [seg("log", "faint")];
  if (start > 0) logHead.push(seg(`   ↑ ${start} earlier · k`, "faint"));
  if (sc > 0) logHead.push(seg("   following paused · j", "amber"));
  rowsOut.push([...pad([seg(`${t.workType}.yaml`, "faint")], left), seg("  "), ...logHead]);
  for (let i = 0; i < room; i++) {
    const treeRow = tree[i] ?? [];
    const ev = evs[i];
    rowsOut.push([...pad(treeRow, left), seg("  "), ...(ev ? clip(eventLine(ev, now, utc), rw) : [])]);
  }
  const inner: Line[] = [...head, ...rowsOut];
  const space = h - 2 - foot.length;
  const padded = inner.slice(0, space);
  while (padded.length < space) padded.push([]);
  const [bc, bold] = borderOf(t, now);
  return box([...padded, ...foot], w, h, bc, bold);
}
