#!/usr/bin/env python3
"""PROTOTYPE - throw away. `abt watch` Board design (ABT-43), single self-contained file.

Read-only TUI mock-up with FAKE in-memory data on a 40 s loop; reads nothing from disk.
- Sidebar (left): live summary, "Board" first, then tickets (now / earlier today).
- Board: every active ticket as a column card: header, nested tree, live log, meter footer.
- Ticket view: header + stepper, question card, tree | full scrollable log, footer.

Run:   python3 abt_watch_board_prototype.py      (Python 3 stdlib only, 256-colour terminal, ~150x44)
Keys:  up/down navigate   b board   j/k scroll log   space pause   q quit
"""

# ======================================================================
# data + derive (from abt_watch_boxes.py)
# ======================================================================
import curses
import locale
import textwrap
import time

LOOP = 40.0
FRESH = 2.0      # seconds an event counts as "new"
SIDEBAR = 36
DAY_START = 9 * 60  # sim minute 0 = 09:00

TREES = {
    "implement": ["assess", "route", "claim", "spec", "build", "verify", "open-pr", "land", "cleanup"],
    "research": ["assess", "route", "claim", "investigate", "findings", "cleanup"],
}

# (t, node, status, text, meta)
# status: ok skip fail -> node finished; info warn decided -> node still going;
#         tx = worker activity from the transcript; esc = escalated to you; end = ticket closed
E = lambda t, n, s, txt, **m: (t, n, s, txt, m)

TICKETS = [
    # ---- finished earlier today (history)
    dict(key="PIR-238", title="Fix shopping list sort", type="implement", events=[
        E(-150, "assess", "ok", "low risk", risk="low"),
        E(-149, "route", "ok", "simple · Sonnet 5.5 medium", grade="simple", cap=45, attempt=1),
        E(-148, "claim", "ok", "feature/PIR-238-list-sort"),
        E(-147, "spec", "skip", "skipped: low risk + covered"),
        E(-140, "build", "tx", "editing src/lib/list.ts  +6 −3"),
        E(-131, "build", "ok", "built in 1 attempt", cost=0.38, tokens=104),
        E(-129, "verify", "ok", "covered by list.test.ts"),
        E(-128, "open-pr", "ok", "PR #85 opened"),
        E(-124, "land", "ok", "squash-merged a71be04"),
        E(-123, "cleanup", "ok", "worktree removed · ticket Done"),
        E(-123, "cleanup", "end", "merged"),
    ]),
    dict(key="PIR-239", title="Stripe webhook retries", type="implement", events=[
        E(-110, "assess", "esc", "high risk: payments. Approve the plan before building?", risk="high"),
        E(-80, "assess", "info", "you replied: abandon (doing it by hand)"),
        E(-80, "cleanup", "ok", "nothing to clean · ticket Abandoned"),
        E(-80, "cleanup", "end", "abandoned"),
    ]),
    dict(key="PIR-240", title="Recipe import formats", type="research", events=[
        E(-70, "assess", "ok", "low risk", risk="low"),
        E(-69, "route", "ok", "standard · Sonnet 5.5 high", grade="standard", cap=90, attempt=1),
        E(-68, "claim", "ok", "claimed (research: no branch)"),
        E(-60, "investigate", "tx", "reading docs: schema.org/Recipe"),
        E(-45, "investigate", "ok", "4 formats compared", cost=0.41, tokens=118),
        E(-42, "findings", "ok", "Linear doc 'Recipe import formats' created"),
        E(-41, "cleanup", "ok", "ticket Done"),
        E(-41, "cleanup", "end", "done"),
    ]),
    # ---- live
    dict(key="PIR-241", title="Meal swap button copy", type="implement", events=[
        E(0, "assess", "ok", "low risk", risk="low"),
        E(2, "route", "ok", "simple · Sonnet 5.5 medium", grade="simple", cap=45, attempt=1),
        E(3, "claim", "ok", "feature/PIR-241-meal-swap-copy"),
        E(5, "spec", "skip", "skipped: low risk + covered"),
        E(6, "build", "tx", "reading src/routes/plan/+page.svelte"),
        E(8, "build", "tx", "editing +page.svelte  +4 −2"),
        E(10, "build", "tx", "running fast check"),
        E(13, "build", "warn", "fast check failed, keeps going (1/3)"),
        E(15, "build", "tx", "editing src/lib/copy.ts  +1 −1"),
        E(17, "build", "tx", "fast check passed"),
        E(18, "build", "decided", "decided alone: rename CTA key (reversible)"),
        E(20, "build", "ok", "built in 1 attempt", cost=0.61, tokens=182),
        E(22, "verify", "ok", "covered by e2e plan.spec.ts"),
        E(24, "open-pr", "ok", "PR #88 opened"),
        E(27, "land", "info", "diff re-checked: still low → merging"),
        E(30, "land", "ok", "squash-merged 3f9a1c2"),
        E(31, "cleanup", "ok", "worktree removed · ticket Done"),
        E(31, "cleanup", "end", "merged"),
    ]),
    dict(key="PIR-243", title="Pantry dedupe in Convex", type="implement", events=[
        E(1, "assess", "ok", "medium risk: touches >15 files", risk="medium"),
        E(2, "route", "ok", "standard · Sonnet 5.5 high", grade="standard", cap=90, attempt=1),
        E(4, "claim", "ok", "feature/PIR-243-convex-pantry"),
        E(7, "spec", "ok", "4 criteria: 3 proved, 1 gap"),
        E(9, "build", "tx", "reading convex/pantry.ts"),
        E(11, "build", "tx", "writing convex/pantry.test.ts"),
        E(14, "build", "tx", "vitest: 2 failed"),
        E(17, "build", "warn", "attempt 1 failed after 17m", cost=0.48, tokens=131),
        E(19, "build", "info", "retrying: attempt 2, same grade", attempt=2),
        E(21, "build", "tx", "editing convex/pantry.ts  +38 −12"),
        E(24, "build", "tx", "vitest passed", cost=0.92, tokens=240),
        E(26, "build", "esc", "Merge duplicate pantry items when one is added? Existing rows would be "
                              "rewritten (irreversible).",
          rec="No: keep both rows and flag the duplicate in the UI."),
    ]),
    dict(key="PIR-244", title="Compare grocery APIs", type="research", events=[
        E(28, "assess", "ok", "low risk", risk="low"),
        E(29, "route", "ok", "standard · Sonnet 5.5 high", grade="standard", cap=90, attempt=1),
        E(30, "claim", "ok", "claimed (research: no branch)"),
        E(31, "investigate", "tx", "reading docs: Grocy API"),
        E(33, "investigate", "tx", "reading docs: Instacart Connect"),
        E(35, "investigate", "tx", "comparing pricing and auth"),
        E(37, "investigate", "ok", "3 options compared", cost=0.33, tokens=95),
        E(38, "findings", "tx", "writing Linear document"),
    ]),
]
BLOCKED = [("PIR-245", "Week view a11y", "blocked by PIR-243")]

# ---------------------------------------------------------------- derive
def derive(tk, t):
    seen = [e for e in tk["events"] if e[0] <= t]
    nodes = {n: ("todo", "") for n in TREES[tk["type"]]}
    meta = {}
    for _, n, s, txt, m in seen:
        meta.update(m)
        if s not in ("tx", "end"):
            nodes[n] = (s, txt)
    ended = [e for e in seen if e[2] == "end"]
    if not seen:
        phase = "queued"
    elif ended:
        phase = ended[-1][3]  # merged / done / abandoned
    elif seen[-1][2] == "esc":
        phase = "needs"
    else:
        phase = "running"
    cur = seen[-1][1] if seen else None
    if phase == "running":
        if nodes[cur][0] not in ("ok", "skip", "fail"):
            nodes[cur] = ("run", nodes[cur][1])
        last_tx = [e for e in seen if e[1] == cur and e[2] == "tx"]
        last_rec = max((e[0] for e in seen if e[1] == cur and e[2] != "tx"), default=-1e9)
        if last_tx and last_tx[-1][0] >= last_rec:
            nodes[cur] = ("run", last_tx[-1][3])
    start = seen[0][0] if seen else t
    end = seen[-1][0] if phase not in ("running", "queued") else t
    return dict(seen=seen, nodes=nodes, meta=meta, phase=phase, cur=cur,
                elapsed=end - start, ended_at=ended[-1][0] if ended else None)

ACTIVE = ("needs", "running")
FINAL = ("merged", "done", "abandoned")

def clock(t):
    m = int(DAY_START + t)
    return f"{m // 60:02d}:{m % 60:02d}"

# ---------------------------------------------------------------- colours
OK, BAD, WARN, DIM, RUN, HIGH, TXT = range(1, 8)

def init_colors():
    curses.use_default_colors()
    gray = 244 if curses.COLORS >= 256 else curses.COLOR_WHITE
    for p, fg in [(OK, curses.COLOR_GREEN), (BAD, curses.COLOR_RED), (WARN, curses.COLOR_YELLOW),
                  (DIM, gray), (RUN, curses.COLOR_CYAN), (HIGH, curses.COLOR_BLUE), (TXT, -1)]:
        curses.init_pair(p, fg, -1)

C = lambda p, extra=0: curses.color_pair(p) | extra

def put(win, y, x, s, attr=0, maxw=None):
    h, w = win.getmaxyx()
    room = w - x - 1 if maxw is None else min(maxw, w - x - 1)
    if 0 <= y < h - 1 and 0 <= x < w and room > 0:
        try:
            win.addnstr(y, x, s, room, attr)
        except curses.error:
            pass

def segs(win, y, x, parts, maxw):
    for text, attr in parts:
        if maxw <= 0:
            break
        put(win, y, x, text, attr, maxw)
        x += len(text)
        maxw -= len(text)

def bar(frac, n=10):
    k = max(0, min(n, round(frac * n)))
    return "▰" * k + "▱" * (n - k)

SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
EV_ICON = {"tx": ("·", DIM), "warn": ("!", WARN), "esc": ("?", WARN), "decided": ("⚑", HIGH),
           "fail": ("✗", BAD), "info": ("›", RUN), "end": ("■", OK)}

def event_parts(e, t, show_node=False):
    et, n, s, txt, m = e
    icon, ic = EV_ICON.get(s, ("✓", OK))
    new = t - et < FRESH
    parts = [(f"{clock(et)} ", C(DIM)), (f"{icon} ", C(ic, curses.A_BOLD))]
    if show_node:
        parts.append((f"{n:<12}", C(DIM)))
    if s == "esc" and m.get("rec"):
        txt = f"{txt}  recommends: {m['rec']}"
    parts.append((txt, C(TXT, curses.A_BOLD) if new else C(DIM if s == "tx" else TXT)))
    if new:
        parts.append(("  new", C(OK, curses.A_BOLD)))
    return parts

# ---------------------------------------------------------------- one box
def box_lines(tk, d, t, now, width):
    pulse = int(now * 2) % 2 == 0
    spin = SPIN[int(now * 10) % len(SPIN)]
    m, phase = d["meta"], d["phase"]
    lines = []

    badge = {"running": (f" {spin} RUNNING ", C(RUN, curses.A_BOLD | curses.A_REVERSE)),
             "needs": (" ● NEEDS YOU ", C(WARN, curses.A_BOLD | (curses.A_REVERSE if pulse else 0)))}[phase]
    risk = m.get("risk", "?")
    rc = {"low": OK, "medium": WARN, "high": BAD}.get(risk, DIM)
    lines.append([badge, (" risk ", C(DIM)), (risk.upper(), C(rc, curses.A_BOLD)),
                  (" · ", C(DIM)), (m.get("grade", "-"), C(TXT)), (" · ", C(DIM)),
                  (tk["type"], C(DIM))])

    cap = m.get("cap", 90)
    frac = d["elapsed"] / cap if cap else 0
    tc = BAD if frac > .8 else WARN if frac > .5 else RUN
    lines.append([("time ", C(DIM)), (bar(frac, 8), C(tc if phase == "running" else DIM)),
                  (f" {int(d['elapsed']):>2}m/{cap}m", C(DIM)),
                  ("  try ", C(DIM)), (bar(m.get("attempt", 0) / 6, 6), C(WARN if m.get("attempt", 0) > 1 else DIM)),
                  (f" {m.get('attempt', 0)}/6", C(DIM)),
                  (f"  ${m['cost']:.2f}" if "cost" in m else "  $ –", C(TXT)),
                  (f" · {m['tokens']}k" if "tokens" in m else "", C(DIM))])

    if phase == "needs":  # the question block: never truncated
        q = d["seen"][-1]
        lines.append([])
        for part in textwrap.wrap(q[3], width - 3):
            lines.append([("  ", 0), (part, C(WARN, curses.A_BOLD))])
        if q[4].get("rec"):
            for i, part in enumerate(textwrap.wrap("recommends: " + q[4]["rec"], width - 3)):
                lines.append([("  ", 0), (part, C(TXT))])
        lines.append([("  reply as a comment on the Linear ticket:", C(DIM))])
        lines.append([("  ", 0), ("yes", C(OK, curses.A_BOLD)), (" takes it · ", C(DIM)),
                      ("answer: <text>", C(TXT, curses.A_BOLD)), (" decides otherwise", C(DIM))])
        lines.append([("  ", 0), ("abandon", C(TXT, curses.A_BOLD)), (" · ", C(DIM)),
                      ("re-run", C(TXT, curses.A_BOLD)), (" · ", C(DIM)), ("raise tier", C(TXT, curses.A_BOLD))])
    lines.append([])

    for n in TREES[tk["type"]]:
        st, txt = d["nodes"][n]
        g, gc = {"ok": ("✓", OK), "skip": ("–", DIM), "fail": ("✗", BAD), "todo": ("·", DIM),
                 "run": (spin, RUN), "esc": ("●" if pulse else "○", WARN),
                 "info": ("›", RUN), "warn": ("!", WARN), "decided": ("⚑", HIGH)}[st]
        is_cur = n == d["cur"]
        name_attr = C(TXT, curses.A_BOLD) if is_cur else C(DIM if st in ("todo", "skip") else TXT)
        txt_attr = C(WARN, curses.A_BOLD) if st == "esc" else C(RUN) if st == "run" else C(DIM)
        if st == "esc":
            txt = "waiting for your reply ↑"
        lines.append([(f" {g} ", C(gc, curses.A_BOLD)), (f"{n:<13}", name_attr), (txt, txt_attr)])

    lines.append([])
    lines.append([("latest", C(DIM, curses.A_UNDERLINE)), ("   enter: full log", C(DIM))])
    for e in d["seen"][-2:]:
        lines.append([(" ", 0)] + event_parts(e, t))
    return lines

def draw_frame_box(win, y, x, h, w, border, title, subtitle=""):
    put(win, y, x, "╭" + "─" * (w - 2) + "╮", border)
    for i in range(1, h - 1):
        put(win, y + i, x, "│", border)
        put(win, y + i, x + w - 1, "│", border)
    put(win, y + h - 1, x, "╰" + "─" * (w - 2) + "╯", border)
    put(win, y, x + 2, f" {title} ", border | curses.A_BOLD)
    if subtitle:
        put(win, y, x + 4 + len(title), f"{subtitle} ", C(TXT, curses.A_BOLD), w - 7 - len(title))

def draw_box(win, y, x, w, tk, d, t, now, selected):
    lines = box_lines(tk, d, t, now, w - 4)
    h = len(lines) + 2
    pulse = int(now * 2) % 2 == 0
    border = {"needs": C(WARN, curses.A_BOLD if pulse else 0), "running": C(RUN)}[d["phase"]]
    if selected:
        border |= curses.A_BOLD
    draw_frame_box(win, y, x, h, w, border, ("▸ " if selected else "") + tk["key"], tk["title"])
    for i, parts in enumerate(lines):
        segs(win, y + 1 + i, x + 2, parts, w - 4)
    return h

# ---------------------------------------------------------------- sidebar
PHASE_GLYPH = {"needs": ("●", WARN), "running": (None, RUN), "queued": ("○", DIM),
               "merged": ("✓", OK), "done": ("✓", OK), "abandoned": ("✗", DIM)}

def sidebar_order(ds):
    rank = {"needs": 0, "running": 1, "queued": 2}
    live = sorted([x for x in ds if x[1]["phase"] in rank], key=lambda x: rank[x[1]["phase"]])
    past = sorted([x for x in ds if x[1]["phase"] in FINAL], key=lambda x: -x[1]["ended_at"])
    return live, past

def draw_sidebar(scr, x, top, h, live, past, sel_key, now):
    spin = SPIN[int(now * 10) % len(SPIN)]
    for yy in range(top, h - 2):
        put(scr, yy, x + SIDEBAR, "│", C(DIM))
    y = top
    def row(tk, d):
        nonlocal y
        g, gc = PHASE_GLYPH[d["phase"]]
        g = g or spin
        sel = tk["key"] == sel_key
        word = {"needs": "needs you", "running": "running", "queued": "queued"}.get(d["phase"], d["phase"])
        segs(scr, y, x + 2, [("▸" if sel else " ", C(TXT, curses.A_BOLD)), (f" {g} ", C(gc, curses.A_BOLD)),
                             (f"{tk['key']} ", C(TXT, curses.A_BOLD if sel else 0)),
                             (word, C(gc if d["phase"] in ACTIVE else DIM))], SIDEBAR - 3)
        y += 1
        put(scr, y, x + 7, tk["title"][:SIDEBAR - 9], C(TXT, curses.A_BOLD) if sel else C(DIM))
        y += 1
    put(scr, y, x + 2, "NOW", C(DIM, curses.A_BOLD)); y += 1
    for tk, d in live:
        row(tk, d)
    for k, title, why in BLOCKED:
        segs(scr, y, x + 2, [("  ○ ", C(DIM)), (f"{k} ", C(TXT)), ("blocked", C(DIM))], SIDEBAR - 3); y += 1
        put(scr, y, x + 7, title[:SIDEBAR - 9], C(DIM)); y += 1
    y += 1
    put(scr, y, x + 2, "EARLIER TODAY", C(DIM, curses.A_BOLD)); y += 1
    for tk, d in past:
        row(tk, d)
    y += 1
    put(scr, y, x + 2, "older days: abt log show <ticket>", C(DIM))

# ---------------------------------------------------------------- views
def header(scr, w, t, ds, paused, view):
    running = sum(1 for _, d in ds if d["phase"] == "running")
    needs = sum(1 for _, d in ds if d["phase"] == "needs")
    queued = sum(1 for _, d in ds if d["phase"] == "queued") + len(BLOCKED)
    segs(scr, 0, 0, [(" abt watch ", C(RUN, curses.A_BOLD | curses.A_REVERSE)),
                     ("  workers ", C(DIM)), (f"{running}/2", C(RUN, curses.A_BOLD)),
                     ("   needs you ", C(DIM)), (str(needs), C(WARN if needs else DIM, curses.A_BOLD)),
                     ("   queue ", C(DIM)), (str(queued), C(TXT, curses.A_BOLD)),
                     ("   dispatch ", C(DIM)), ("PAUSED" if paused else "on", C(WARN if paused else OK, curses.A_BOLD)),
                     (f"   piron · {clock(t)}", C(DIM)),
                     (f"   view: {view}", C(DIM))], w)

def boards(scr, area_w, t, now, live, sel_key):
    active = [x for x in live if x[1]["phase"] in ACTIVE]
    if not active:
        put(scr, 3, 2, "no workers running", C(DIM))
        return
    cols = max(1, min(len(active), area_w // 56))
    bw = area_w // cols
    y, col, row_h = 2, 0, 0
    for tk, d in active:
        bh = draw_box(scr, y, col * bw, bw - 1, tk, d, t, now, tk["key"] == sel_key)
        row_h = max(row_h, bh)
        col += 1
        if col == cols:
            col, y, row_h = 0, y + row_h, 0

def log_view(scr, area_w, h, t, tk, d, scroll):
    m = d["meta"]
    border = C({"needs": WARN, "running": RUN}.get(d["phase"], DIM))
    bh = h - 4
    draw_frame_box(scr, 2, 0, bh, area_w - 1, border, f"{tk['key']} · full log", tk["title"])
    summary = (f"{d['phase']}  ·  {tk['type']}  ·  risk {m.get('risk', '?')}  ·  {m.get('grade', '-')}  ·  "
               f"{int(d['elapsed'])}m  ·  " + (f"${m['cost']:.2f}" if "cost" in m else "$ –"))
    put(scr, 3, 2, summary, C(TXT))
    rows = []
    for e in d["seen"]:
        rows.append(event_parts(e, t, show_node=True))
    inner = bh - 4
    max_scroll = max(0, len(rows) - inner)
    start = max(0, max_scroll - scroll)
    for i, parts in enumerate(rows[start:start + inner]):
        segs(scr, 5 + i, 2, parts, area_w - 5)
    if start > 0:
        put(scr, 4, area_w - 18, f"↑ {start} earlier", C(DIM))
    return max_scroll

class Offset:
    """Draw into the screen shifted right by dx (main area beside the left sidebar)."""
    def __init__(self, win, dx):
        self.win, self.dx = win, dx
    def getmaxyx(self):
        h, w = self.win.getmaxyx()
        return h, w - self.dx
    def addnstr(self, y, x, s, n, attr=0):
        self.win.addnstr(y, x + self.dx, s, n, attr)

def frame(scr, t, now, paused, ui):
    h, w = scr.getmaxyx()
    ds = [(tk, derive(tk, t)) for tk in TICKETS]
    live, past = sidebar_order(ds)
    order = [tk["key"] for tk, _ in live + past]
    if ui["sel"] not in order:
        ui["sel"] = order[0]
    sel = next(x for x in ds if x[0]["key"] == ui["sel"])
    side = w >= 100
    area_w = w - SIDEBAR - 1 if side else w
    header(scr, w, t, ds, paused, "log" if ui["log"] else "board")
    main_win = Offset(scr, SIDEBAR + 2) if side else scr
    if ui["log"] or sel[1]["phase"] in FINAL:
        ui["max_scroll"] = log_view(main_win, area_w - 1, h, t, sel[0], sel[1], ui["scroll"])
    else:
        boards(main_win, area_w - 1, t, now, live, ui["sel"])
    if side:
        draw_sidebar(scr, 0, 2, h, live, past, ui["sel"], now)
    put(scr, h - 2, 1, "✓ done ⠋ working ● needs you – skipped · not yet ⚑ decided alone  │  "
        "↑↓ select  enter log  j/k scroll  space pause  q quit", C(DIM))
    return order

def main(scr):
    curses.curs_set(0)
    init_colors()
    scr.timeout(100)
    scr.keypad(True)
    start, paused_at = time.time(), None
    ui = dict(sel=None, log=False, scroll=0, max_scroll=0)
    while True:
        now = time.time()
        t = ((paused_at or now) - start) % LOOP
        scr.erase()
        order = frame(scr, t, now, paused_at is not None, ui)
        scr.refresh()
        ch = scr.getch()
        if ch in (ord("q"), 27) and not ui["log"]:
            return
        if ch == 27 or (ch in (10, 13, curses.KEY_ENTER)):
            ui["log"] = not ui["log"] if ch != 27 else False
            ui["scroll"] = 0
        elif ch == ord("q"):
            ui["log"] = False
        elif ch in (curses.KEY_DOWN, curses.KEY_UP):
            i = order.index(ui["sel"]) + (1 if ch == curses.KEY_DOWN else -1)
            ui["sel"] = order[i % len(order)]
            ui["scroll"] = 0
        elif ch == ord("k"):
            ui["scroll"] = min(ui["max_scroll"], ui["scroll"] + 1)
        elif ch == ord("j"):
            ui["scroll"] = max(0, ui["scroll"] - 1)
        elif ch == ord(" "):
            if paused_at:
                start += now - paused_at
                paused_at = None
            else:
                paused_at = now

# ======================================================================
# visual primitives (from abt_watch_studio.py)
# ======================================================================
import curses
import locale
import math
import sys
import textwrap
import time


SB = 32          # sidebar width
FRESH = 2.0

# ---------------------------------------------------------------- palette
P = dict(side=234, card=235, raised=237, line=238, faint=241, muted=246, text=252, bright=255,
         teal=44, amber=214, rose=204, green=114, blue=75, ink=233)
RAMP = {"teal": [30, 37, 44, 51, 44, 37], "amber": [136, 172, 214, 221, 214, 172]}
BASIC = {234: -1, 235: -1, 237: -1, 238: -1, 233: 0, 241: 7, 246: 7, 252: -1, 255: 15,
         44: 6, 214: 3, 204: 1, 114: 2, 75: 4, 30: 6, 37: 6, 51: 6, 136: 3, 172: 3, 221: 3}
_pairs = {}

def A(fg, bg="card", bold=False, rev=False):
    fg = P.get(fg, fg)
    bg = -1 if bg is None else P.get(bg, bg)
    if curses.COLORS < 256:
        fg, bg = BASIC.get(fg, -1), BASIC.get(bg, -1)
    key = (fg, bg)
    if key not in _pairs:
        _pairs[key] = len(_pairs) + 1
        curses.init_pair(_pairs[key], fg, bg)
    return curses.color_pair(_pairs[key]) | (curses.A_BOLD if bold else 0) | (curses.A_REVERSE if rev else 0)

STATE = {"needs": "amber", "running": "teal", "merged": "green", "done": "green",
         "abandoned": "muted", "queued": "faint"}
STATE_WORD = {"needs": "NEEDS YOU", "running": "RUNNING", "merged": "MERGED", "done": "DONE",
              "abandoned": "ABANDONED", "queued": "QUEUED"}

def pulse(name, now):
    r = RAMP[name]
    return r[int(now * 8) % len(r)]

# ---------------------------------------------------------------- primitives
def put(win, y, x, s, attr=0, maxw=None):
    h, w = win.getmaxyx()
    room = w - x - 1 if maxw is None else min(maxw, w - x - 1)
    if 0 <= y < h - 1 and 0 <= x < w and room > 0:
        try:
            win.addnstr(y, x, s, room, attr)
        except curses.error:
            pass

def run(win, y, x, parts, maxw):
    """parts: [(text, attr)] drawn left to right, clipped to maxw. Returns end x."""
    for s, a in parts:
        if maxw <= 0:
            break
        put(win, y, x, s, a, maxw)
        x += len(s)
        maxw -= len(s)
    return x

def fill(win, y, x, w, bg):
    put(win, y, x, " " * w, A("text", bg), w)

def panel(win, y, x, h, w, bg="card", accent=None):
    for i in range(h):
        fill(win, y + i, x, w, bg)
        if accent:
            put(win, y + i, x, "▌", A(accent, bg))

def sbar(frac, width):
    """smooth bar with 1/8 cell resolution"""
    eighths = max(0, min(width * 8, int(round(frac * width * 8))))
    full, rem = divmod(eighths, 8)
    s = "█" * full + ("▏▎▍▌▋▊▉"[rem - 1] if rem else "")
    return s, width - len(s)

def meter(win, y, x, frac, width, color, bg="card"):
    s, rest = sbar(frac, width)
    put(win, y, x, s, A(color, bg))
    put(win, y, x + len(s), "─" * rest, A("line", bg))

def spark(d, t, n=16):
    """events per minute over the last n minutes as a sparkline"""
    buckets = [0] * n
    for e in d["seen"]:
        age = t - e[0]
        if 0 <= age < n:
            buckets[n - 1 - int(age)] += 1
    top = max(buckets) or 1
    chars = " ▁▂▃▄▅▆▇█"
    return "".join(chars[0 if b == 0 else 1 + int(b / top * 7)] for b in buckets)

def pill(win, y, x, text, color, now=None, bg="card"):
    c = pulse(color, now) if now is not None and color in RAMP else P[color]
    put(win, y, x, f" {text} ", A("ink", c, bold=True))
    return x + len(text) + 2

def chip(win, y, x, text, fg="text", bg="raised"):
    put(win, y, x, f" {text} ", A(fg, bg, bold=True))
    return x + len(text) + 3

SHORT = {"open-pr": "PR", "cleanup": "clean", "investigate": "research", "findings": "write-up"}

# ---------------------------------------------------------------- sidebar
def sidebar(win, h, t, now, live, past, sel_key, ds, paused):
    for y in range(h - 1):
        fill(win, y, 0, SB, "side")
    run(win, 1, 2, [("◆ ", A("teal", "side", True)), ("abt watch", A("bright", "side", True))], SB - 3)
    run(win, 2, 2, [(f"piron · {clock(t)}", A("muted", "side"))], SB - 3)
    running = sum(1 for _, d in ds if d["phase"] == "running")
    needs = sum(1 for _, d in ds if d["phase"] == "needs")
    queued = sum(1 for _, d in ds if d["phase"] == "queued") + len(BLOCKED)
    run(win, 4, 2, [("workers ", A("muted", "side")), ("●" * running, A("teal", "side", True)),
                    ("○" * (2 - running), A("faint", "side")),
                    ("  needs ", A("muted", "side")), (str(needs), A("amber" if needs else "faint", "side", True)),
                    ("  queue ", A("muted", "side")), (str(queued), A("text", "side", True))], SB - 3)
    run(win, 5, 2, [("dispatch ", A("muted", "side")),
                    ("paused" if paused else "on", A("amber" if paused else "green", "side", True))], SB - 3)
    y = 7
    spin = SPIN[int(now * 10) % len(SPIN)]

    def row(key, title, phase, selected):
        nonlocal y
        col = STATE[phase]
        bg = "raised" if selected else "side"
        fill(win, y, 0, SB, bg); fill(win, y + 1, 0, SB, bg)
        if selected:
            put(win, y, 0, "▌", A(col, bg)); put(win, y + 1, 0, "▌", A(col, bg))
        g = {"needs": "●", "running": spin, "merged": "✓", "done": "✓", "abandoned": "✕", "queued": "○"}[phase]
        gc = pulse("amber", now) if phase == "needs" else P[col]
        run(win, y, 2, [(g + " ", A(gc, bg, True)), (key, A("bright" if selected else "text", bg, True)),
                        ("  " + STATE_WORD[phase].lower(), A(col if phase in ACTIVE else "muted", bg))], SB - 3)
        put(win, y + 1, 4, title[:SB - 6], A("text" if selected else "muted", bg))
        y += 2

    put(win, y, 2, "NOW", A("faint", "side", True)); y += 1
    for tk, d in live:
        row(tk["key"], tk["title"], d["phase"], tk["key"] == sel_key)
    for k, title, why in BLOCKED:
        fill(win, y, 0, SB, "side")
        run(win, y, 2, [("○ ", A("faint", "side")), (k, A("muted", "side", True)), ("  blocked", A("faint", "side"))], SB - 3)
        put(win, y + 1, 4, title[:SB - 6], A("faint", "side"))
        y += 2
    y += 1
    put(win, y, 2, "EARLIER TODAY", A("faint", "side", True)); y += 1
    for tk, d in past:
        row(tk["key"], tk["title"], d["phase"], tk["key"] == sel_key)
    put(win, h - 3, 2, "older: abt log show <id>", A("faint", "side"))

# ---------------------------------------------------------------- shared bits
def ask_card(win, y, x, w, d, now):
    """The escalation: question, recommendation, how to reply. Returns rows used."""
    q = d["seen"][-1]
    lines = textwrap.wrap(q[3], w - 6)
    rec = textwrap.wrap(q[4].get("rec", ""), w - 20) if q[4].get("rec") else []
    h = len(lines) + len(rec) + 4
    panel(win, y, x, h, w, "raised", accent=pulse("amber", now))
    put(win, y, x + 2, "QUESTION FOR YOU", A("amber", "raised", True))
    for i, l in enumerate(lines):
        put(win, y + 1 + i, x + 2, l, A("bright", "raised", True))
    yy = y + 1 + len(lines)
    for i, l in enumerate(rec):
        run(win, yy + i, x + 2, [("recommends  " if i == 0 else "            ", A("muted", "raised")),
                                 (l, A("text", "raised"))], w - 4)
    yy += len(rec)
    xx = run(win, yy + 1, x + 2, [("reply in Linear  ", A("muted", "raised"))], w - 4)
    for word, fg in [("yes", "green"), ("answer: …", "text"), ("abandon", "text"), ("re-run", "text"), ("raise tier", "text")]:
        if xx + len(word) + 3 < x + w:
            xx = chip(win, yy + 1, xx, word, fg, "line")
    return h

def now_text(d):
    cur = d["cur"]
    st, txt = d["nodes"][cur] if cur else ("todo", "")
    return cur, txt

EV = {"tx": ("·", "muted"), "warn": ("!", "amber"), "esc": ("?", "amber"), "decided": ("⚑", "blue"),
      "fail": ("✕", "rose"), "info": ("›", "teal"), "end": ("■", "green"), "skip": ("–", "faint")}

def event_row(win, y, x, w, e, t, bg="card", node=True):
    et, n, s, txt, m = e
    icon, col = EV.get(s, ("✓", "green"))
    new = t - et < FRESH
    parts = [(clock(et) + "  ", A("faint", bg)), (icon + " ", A(col, bg, True))]
    if node:
        parts.append((f"{SHORT.get(n, n):<9}", A("muted", bg)))
    parts.append((txt, A("bright" if new else ("muted" if s == "tx" else "text"), bg, new)))
    end = run(win, y, x, parts, w)
    if new and end + 5 < x + w:
        put(win, y, end + 1, "new", A("green", bg, True))

def nested(tk, d):
    """Top-level steps plus the children of the current step (the real tree is nested)."""
    rows = []
    m = d["meta"]
    for n in TREES[tk["type"]]:
        st, txt = d["nodes"][n]
        rows.append((0, n, st, txt))
        if n == d["cur"] and d["phase"] in ACTIVE and n in ("build", "investigate"):
            agent = "tdd-afk" if n == "build" else "research-afk"
            rows.append((1, "retry", "esc" if st == "esc" else "run", f"routing ladder · try {m.get('attempt', 1)}/6 · {m.get('grade', '')}"))
            last_tx = [e for e in d["seen"] if e[1] == n and e[2] == "tx"]
            rows.append((2, f"agent {agent}", "esc" if st == "esc" else "run", last_tx[-1][3] if last_tx else ""))
            if n == "build":
                warn = [e for e in d["seen"] if e[1] == n and e[2] == "warn"]
                rows.append((2, "check fast", "warn" if warn else "ok", "stop hook · " + (warn[-1][3] if warn else "passing")))
    return rows

GLYPH = {"ok": ("✓", "green"), "skip": ("–", "faint"), "fail": ("✕", "rose"), "todo": ("○", "faint"),
         "info": ("›", "teal"), "warn": ("!", "amber"), "decided": ("⚑", "blue")}

def glyph(st, now):
    if st == "run":
        return SPIN[int(now * 10) % len(SPIN)], P["teal"]
    if st == "esc":
        return "●", pulse("amber", now)
    g, c = GLYPH[st]
    return g, P[c]

def tree_rows(win, y, x, w, tk, d, now, bg="card"):
    rows = nested(tk, d)
    for i, (depth, name, st, txt) in enumerate(rows):
        nxt = next((r[0] for r in rows[i + 1:] if r[0] <= depth), -1)
        last_sib = nxt < depth
        if depth == 0:
            branch = "└─ " if last_sib else "├─ "
        else:
            branch = "│  " + "   " * (depth - 1) + ("└─ " if last_sib else "├─ ")
        g, gc = glyph(st, now)
        cur = name == d["cur"]
        if st == "esc" and depth == 0:
            txt = "waiting for your reply"
        run(win, y + i, x, [(branch, A("line", bg)), (g + " ", A(gc, bg, True)),
                            (f"{name:<{max(16 - 3 * depth, len(name) + 2)}}", A("bright" if cur else ("text" if depth else "muted" if st in ('todo', 'skip') else "text"), bg, cur)),
                            (txt, A("teal" if st == "run" else "amber" if st == "esc" else "muted", bg))], w)
    return len(rows)

def log_card(win, x, y, w, h, tk, d, t, scroll):
    panel(win, y, x, h, w, "card")
    col = STATE[d["phase"]]
    xx = pill(win, y + 1, x + 2, STATE_WORD[d["phase"]], col)
    run(win, y + 1, xx + 1, [(tk["key"], A("bright", "card", True)), ("  " + tk["title"], A("text", "card")),
                             ("   full log", A("muted", "card"))], w - (xx - x) - 4)
    m = d["meta"]
    run(win, y + 2, x + 2, [(f"{tk['type']} · risk {m.get('risk', '?')} · {m.get('grade', '-')} · "
                             f"{int(d['elapsed'])}m · " + (f"${m['cost']:.2f}" if 'cost' in m else "$ –"), A("muted", "card"))], w - 4)
    inner = h - 5
    rows = d["seen"]
    max_scroll = max(0, len(rows) - inner)
    start = max(0, max_scroll - scroll)
    for i, e in enumerate(rows[start:start + inner]):
        event_row(win, y + 4 + i, x + 2, w - 4, e, t)
    if start:
        put(win, y + 3, x + w - 16, f"↑ {start} earlier", A("faint", "card"))
    return max_scroll

# ---------------------------------------------------------------- variant 1: pipeline
def stepper(win, y, x, w, tk, d, now):
    nodes = TREES[tk["type"]]
    seg = max(8, min(12, (w - 2) // len(nodes)))
    for i, n in enumerate(nodes):
        st, _ = d["nodes"][n]
        cx = x + i * seg
        if st in ("ok",):
            g, c = "●", P["green"]
        elif st == "skip":
            g, c = "◌", P["faint"]
        elif st in ("run", "info", "warn", "decided"):
            g, c = "◉", pulse("teal", now)
        elif st == "esc":
            g, c = "◉", pulse("amber", now)
        elif st == "fail":
            g, c = "✕", P["rose"]
        else:
            g, c = "○", P["faint"]
        put(win, y, cx, g, A(c, "card", True))
        if i < len(nodes) - 1:
            done = st in ("ok", "skip")
            put(win, y, cx + 1, ("━" if done else "┄") * (seg - 1), A("green" if done else "line", "card"))
        label = SHORT.get(n, n)
        cur = n == d["cur"] and d["phase"] in ACTIVE
        put(win, y + 1, cx, label[:seg - 1], A("bright" if cur else "muted" if st != "todo" else "faint", "card", cur))

def v_pipeline(win, x, y, w, h, t, now, ds, live, sel_key):
    active = [(tk, d) for tk, d in live if d["phase"] in ACTIVE]
    if not active:
        put(win, y + 1, x + 2, "No workers running.", A("muted", None))
    for tk, d in active:
        col = STATE[d["phase"]]
        sel = tk["key"] == sel_key
        m = d["meta"]
        body = 8 + (0 if d["phase"] != "needs" else 0)
        ask_h = 0
        if d["phase"] == "needs":
            q = d["seen"][-1]
            ask_h = len(textwrap.wrap(q[3], w - 10)) + len(textwrap.wrap(q[4].get("rec", ""), w - 24)) + 5
        ch = body + ask_h
        if y + ch > h - 2:
            put(win, y, x + 2, f"+ {tk['key']} (make the window taller)", A("muted", None))
            break
        accent = pulse("amber", now) if d["phase"] == "needs" else P[col] if sel else None
        panel(win, y, x, ch, w, "card", accent=accent)
        xx = pill(win, y + 1, x + 3, STATE_WORD[d["phase"]], col, now if d["phase"] == "needs" else None)
        run(win, y + 1, xx + 1, [(tk["key"], A("bright", "card", True)), ("  " + tk["title"], A("text", "card"))], w - (xx - x) - 30)
        risk = m.get("risk", "?")
        rc = {"low": "green", "medium": "amber", "high": "rose"}.get(risk, "muted")
        meta = f"{tk['type']} · {m.get('grade', '-')}"
        run(win, y + 1, x + w - len(meta) - 14, [("risk ", A("muted", "card")), (f"{risk:<7}", A(rc, "card", True)),
                                                 (meta, A("muted", "card"))], 40)
        stepper(win, y + 3, x + 3, w - 6, tk, d, now)
        yy = y + 5
        if d["phase"] == "needs":
            yy += ask_card(win, yy + 1, x + 3, w - 6, d, now) + 1
        else:
            cur, txt = now_text(d)
            spin = SPIN[int(now * 10) % len(SPIN)]
            run(win, yy + 1, x + 3, [(spin + " ", A("teal", "card", True)), (f"{SHORT.get(cur, cur)}  ", A("bright", "card", True)),
                                     (txt, A("teal", "card"))], w - 6)
            yy += 2
        cap = m.get("cap", 90)
        frac = d["elapsed"] / cap
        tc = "rose" if frac > .8 else "amber" if frac > .5 else "teal"
        put(win, yy + 1, x + 3, "time", A("muted", "card"))
        meter(win, yy + 1, x + 8, frac, 14, tc if d["phase"] == "running" else "faint")
        put(win, yy + 1, x + 23, f"{int(d['elapsed']):>2}/{cap}m", A("muted", "card"))
        a = m.get("attempt", 0)
        run(win, yy + 1, x + 33, [("tries ", A("muted", "card")), ("●" * a, A("amber" if a > 1 else "teal", "card", True)),
                                  ("○" * (6 - a), A("line", "card"))], 14)
        run(win, yy + 1, x + 48, [(f"${m['cost']:.2f}" if "cost" in m else "$ –", A("text", "card", True)),
                                  (f" · {m['tokens']}k tok" if "tokens" in m else "", A("muted", "card"))], 20)
        if x + 70 + 20 < x + w:
            run(win, yy + 1, x + 70, [("activity ", A("muted", "card")), (spark(d, t), A(col, "card"))], 26)
        y += ch + 1

# ---------------------------------------------------------------- variant 2: timeline
WINDOW = 60  # minutes on screen

def v_timeline(win, x, y, w, h, t, now, ds, live, sel_key):
    label_w = 12
    lane_w = w - label_w - 4
    t0 = t - WINDOW
    col_of = lambda tt: x + label_w + 2 + int((tt - t0) / WINDOW * (lane_w - 1))
    panel(win, y, x, 4 + 2 * len(ds), w, "card")
    # axis
    for k in range(int(t0 // 10) * 10 + 10, int(t) + 1, 10):
        cx = col_of(k)
        put(win, y + 1, cx - 2, clock(k), A("faint", "card"))
        put(win, y + 2, cx, "┊", A("line", "card"))
    put(win, y + 1, col_of(t) - 1, "now", A("teal", "card", True))
    put(win, y + 2, col_of(t), "▼", A(pulse("teal", now), "card", True))
    lanes = [(tk, d) for tk, d in ds if d["seen"] and d["seen"][-1][0] >= t0 or d["phase"] in ACTIVE]
    order = {k: i for i, k in enumerate(["needs", "running", "merged", "done", "abandoned"])}
    lanes.sort(key=lambda x_: (order.get(x_[1]["phase"], 9), x_[0]["key"]))
    yy = y + 3
    for tk, d in lanes:
        sel = tk["key"] == sel_key
        col = STATE[d["phase"]]
        if sel:
            fill(win, yy, x, w, "raised")
        bg = "raised" if sel else "card"
        put(win, yy, x + 1, "▌" if sel else " ", A(col, bg))
        put(win, yy, x + 2, tk["key"], A("bright" if sel else "text", bg, True))
        # background track
        put(win, yy, x + label_w + 2, "·" * lane_w, A("line", bg))
        ev = d["seen"]
        end_t = t if d["phase"] in ACTIVE else ev[-1][0]
        # segments: colour each minute by what was happening
        for i, e in enumerate(ev):
            s_t = max(e[0], t0)
            e_t = ev[i + 1][0] if i + 1 < len(ev) else end_t
            if e_t < t0:
                continue
            kind = e[2]
            if kind == "esc":
                ch, c = "▒", pulse("amber", now) if d["phase"] == "needs" and i == len(ev) - 1 else P["amber"]
            elif e[1] in ("build", "investigate"):
                ch, c = "█", P["teal"]
            elif kind == "end":
                continue
            else:
                ch, c = "▆", P["blue"]
            a, b = col_of(s_t), col_of(min(e_t, t))
            put(win, yy, a, ch * max(1, b - a), A(c, bg))
        for e in ev:
            if e[0] >= t0 and e[2] in ("warn", "esc", "decided", "fail", "end"):
                icon, c = EV[e[2]]
                put(win, yy, col_of(e[0]), icon, A("ink", P[c] if c in P else c, True))
        if d["phase"] in FINAL:
            put(win, yy, min(col_of(end_t) + 2, x + w - 12), STATE_WORD[d["phase"]].lower(), A(col, bg))
        yy += 2
    run(win, yy, x + label_w + 2, [("█ ", A("teal", "card")), ("agent working  ", A("muted", "card")),
                                   ("▆ ", A("blue", "card")), ("runner step  ", A("muted", "card")),
                                   ("▒ ", A("amber", "card")), ("waiting on you  ", A("muted", "card")),
                                   ("! ⚑ ? ■", A("muted", "card")), ("  markers", A("faint", "card"))], lane_w)
    detail(win, x, yy + 2, w, h, t, now, ds, sel_key)

def detail(win, x, dy, w, h, t, now, ds, sel_key):
    """detail panel for the selected ticket: nested tree + question or latest events"""
    tk, d = next(x_ for x_ in ds if x_[0]["key"] == sel_key)
    dh = h - dy - 1
    if dh < 8:
        return
    left_w = min(64, w // 2)
    panel(win, dy, x, dh, w, "card")
    xx = pill(win, dy + 1, x + 2, STATE_WORD[d["phase"]], STATE[d["phase"]], now if d["phase"] == "needs" else None)
    run(win, dy + 1, xx + 1, [(tk["key"], A("bright", "card", True)), ("  " + tk["title"], A("text", "card"))], w - 30)
    put(win, dy + 3, x + 2, f"{tk['type']}.yaml", A("faint", "card"))
    tree_rows(win, dy + 4, x + 2, left_w - 4, tk, d, now)
    rx = x + left_w + 1
    if d["phase"] == "needs":
        ask_card(win, dy + 3, rx, w - left_w - 3, d, now)
    else:
        put(win, dy + 3, rx, "latest", A("faint", "card"))
        for i, e in enumerate(d["seen"][-(dh - 5):]):
            event_row(win, dy + 4 + i, rx, w - left_w - 3, e, t)

# ---------------------------------------------------------------- variant 3: focus
def v_focus(win, x, y, w, h, t, now, ds, live, sel_key):
    others = [(tk, d) for tk, d in live if d["phase"] in ACTIVE and tk["key"] != sel_key]
    # strip of compact cards
    if others:
        cw = min(46, w // max(1, len(others)))
        for i, (tk, d) in enumerate(others):
            cx = x + i * (cw + 1)
            panel(win, y, cx, 3, cw, "card", accent=pulse("amber", now) if d["phase"] == "needs" else P[STATE[d["phase"]]])
            spin = SPIN[int(now * 10) % len(SPIN)]
            g = "●" if d["phase"] == "needs" else spin
            gc = pulse("amber", now) if d["phase"] == "needs" else P["teal"]
            run(win, y, cx + 2, [(g + " ", A(gc, "card", True)), (tk["key"], A("bright", "card", True)),
                                 ("  " + tk["title"], A("muted", "card"))], cw - 3)
            cur, txt = now_text(d)
            if d["phase"] == "needs":
                txt = "asks you a question"
            run(win, y + 1, cx + 4, [(f"{SHORT.get(cur, cur)} ", A("text", "card", True)), (txt, A("muted", "card"))], cw - 5)
            done = sum(1 for n in TREES[tk["type"]] if d["nodes"][n][0] in ("ok", "skip"))
            meter(win, y + 2, cx + 4, done / len(TREES[tk["type"]]), cw - 8, STATE[d["phase"]])
        y += 4
    tk, d = next(x_ for x_ in ds if x_[0]["key"] == sel_key)
    hh = h - y - 1
    panel(win, y, x, hh, w, "card", accent=pulse("amber", now) if d["phase"] == "needs" else P[STATE[d["phase"]]])
    xx = pill(win, y + 1, x + 3, STATE_WORD[d["phase"]], STATE[d["phase"]], now if d["phase"] == "needs" else None)
    run(win, y + 1, xx + 1, [(tk["key"], A("bright", "card", True)), ("  " + tk["title"], A("bright", "card"))], w - 40)
    m = d["meta"]
    risk = m.get("risk", "?")
    rc = {"low": "green", "medium": "amber", "high": "rose"}.get(risk, "muted")
    run(win, y + 2, x + 3, [("risk ", A("muted", "card")), (risk, A(rc, "card", True)),
                            (f"   grade {m.get('grade', '-')}   ", A("muted", "card")),
                            (f"tries {m.get('attempt', 0)}/6   ", A("muted", "card")),
                            (f"${m['cost']:.2f}" if "cost" in m else "$ –", A("text", "card", True)),
                            (f"   {int(d['elapsed'])}m of {m.get('cap', 90)}m", A("muted", "card"))], w - 6)
    if d["phase"] in ACTIVE:
        meter(win, y + 3, x + 3, d["elapsed"] / m.get("cap", 90), w - 8, "amber" if d["phase"] == "needs" else "teal")
    left_w = min(70, int(w * .5))
    yy = y + 5
    if d["phase"] == "needs":
        yy += ask_card(win, yy, x + 3, w - 6, d, now) + 1
    put(win, yy, x + 3, f"{tk['type']}.yaml", A("faint", "card"))
    tree_rows(win, yy + 1, x + 3, left_w - 4, tk, d, now)
    # live log on the right, full height, auto-follow
    lx = x + left_w + 1
    put(win, yy, lx, "log", A("faint", "card"))
    room = hh - (yy - y) - 2
    for i, e in enumerate(d["seen"][-room:]):
        event_row(win, yy + 1 + i, lx, w - left_w - 4, e, t, node=False)

# ---------------------------------------------------------------- variant 4: timeline, refined
# Fixed axis (no scrolling: the past never moves), thin lines, half-cell growth at the tip,
# a quiet now-line, and one gentle animation: the live tip.
AXIS = (-45.0, 45.0)   # minutes shown; real tool: today's working window, re-paged only when full
SEG = {"agent": ("━", "teal"), "runner": ("━", 67), "wait": ("┄", "amber")}

def hline(win, y, a, b, ch, attr, half=None):
    """draw from float column a to b; a half character at the tip gives 2x resolution"""
    ia, ib = int(round(a)), int(round(b)) if not half else int(b)
    if ib > ia:
        put(win, y, ia, ch * (ib - ia), attr)
    if half and b - ib >= 0.5:
        put(win, y, ib, half, attr)

def v_timeline2(win, x, y, w, h, t, now, ds, live, sel_key):
    label_w = 20
    lx = x + label_w + 2
    lane_w = w - label_w - 6
    t0, t1 = AXIS
    col = lambda tt: lx + (tt - t0) / (t1 - t0) * (lane_w - 1)
    lanes = [(tk, d) for tk, d in ds if d["seen"] and (d["seen"][-1][0] > t0 or d["phase"] in ACTIVE)]
    order = {k: i for i, k in enumerate(["needs", "running", "merged", "done", "abandoned"])}
    lanes.sort(key=lambda x_: (order.get(x_[1]["phase"], 9), x_[0]["key"]))
    ph = 5 + 2 * len(lanes)
    panel(win, y, x, ph, w, "card")
    # axis: hour labels brighter, 10-minute ticks faint; drawn once, never scrolls
    put(win, y + 2, lx, "─" * lane_w, A("line", "card"))
    for k in range(int(t0 // 10 * 10), int(t1) + 1, 10):
        if t0 <= k <= t1:
            c = int(col(k))
            hour = (9 * 60 + k) % 60 == 0
            put(win, y + 2, c, "┴" if hour else "╵", A("muted" if hour else "line", "card"))
            if abs(c - col(t)) > 7:
                put(win, y + 1, c - 2, clock(k), A("text" if hour else "faint", "card", hour))
    nc = int(round(col(t)))
    put(win, y + 1, nc - 2, clock(t), A("teal", "card", True))
    yy = y + 3
    for tk, d in lanes:
        sel = tk["key"] == sel_key
        bg = "raised" if sel else "card"
        if sel:
            fill(win, yy, x, label_w + 1, "raised")
            put(win, yy, x, "▌", A(STATE[d["phase"]], "raised"))
        g = {"needs": "●", "running": SPIN[int(now * 10) % len(SPIN)], "merged": "✓", "done": "✓", "abandoned": "✕"}[d["phase"]]
        gc = P[STATE[d["phase"]]]
        run(win, yy, x + 2, [(g + " ", A(gc, bg, True)), (tk["key"], A("bright" if sel else "text", bg, True))], label_w)
        put(win, yy + 1, x + 4, tk["title"][:label_w - 3], A("muted" if sel else "faint", "card"))
        ev = d["seen"]
        live_lane = d["phase"] in ACTIVE
        end_t = t if live_lane else ev[-1][0]
        # faint baseline only where the ticket existed
        hline(win, yy, max(col(ev[0][0]), lx), col(end_t), "─", A("line", "card"))
        for i, e in enumerate(ev):
            a_t = max(e[0], t0)
            b_t = ev[i + 1][0] if i + 1 < len(ev) else end_t
            if b_t <= t0 or e[2] == "end":
                continue
            kind = "wait" if e[2] == "esc" else "agent" if e[1] in ("build", "investigate") else "runner"
            ch, c = SEG[kind]
            last_seg = i + 1 >= len(ev) or ev[i + 1][2] == "end"
            hline(win, yy, col(a_t), col(b_t), ch, A(c, "card", kind == "agent"),
                  "╸" if ch == "━" and last_seg and live_lane else None)
        # markers sit on the line, coloured glyph on the card colour (no blocks)
        for e in ev:
            if e[0] >= t0 and e[2] in ("warn", "decided", "fail"):
                icon, c = {"warn": ("▲", "amber"), "decided": ("◆", "blue"), "fail": ("✕", "rose")}[e[2]]
                put(win, yy, int(round(col(e[0]))), icon, A(c, "card", True))
        tip = int(col(end_t))
        if d["phase"] == "running":           # the one animation: a soft breathing tip
            put(win, yy, tip, "●", A(RAMP["teal"][int(now * 4) % 6], "card", True))
        elif d["phase"] == "needs":
            put(win, yy, tip, "◉", A(RAMP["amber"][int(now * 3) % 6], "card", True))
            put(win, yy, tip + 2, "waiting on you", A("amber", "card"))
        elif d["phase"] in FINAL:
            put(win, yy, tip, "■" if d["phase"] != "abandoned" else "✕", A(STATE[d["phase"]], "card", True))
            put(win, yy, tip + 2, d["phase"], A("muted", "card"))
        # selected lane: step names under its segments
        if sel:
            last_x = -1
            for n in TREES[tk["type"]]:
                first = next((e for e in ev if e[1] == n and e[2] != "end"), None)
                if first and first[0] >= t0:
                    cx = int(round(col(first[0])))
                    if cx > last_x:
                        lbl = SHORT.get(n, n)
                        put(win, yy + 1, cx, lbl, A("muted", "card"))
                        last_x = cx + len(lbl)
        yy += 2
    # quiet now-line through the lanes
    for ry in range(y + 3, yy):
        if ry % 2 == (y + 4) % 2:
            put(win, ry, nc, "┊", A("line", "card"))
    run(win, yy, lx, [("━ ", A("teal", "card", True)), ("agent  ", A("muted", "card")),
                      ("━ ", A(67, "card")), ("runner  ", A("muted", "card")),
                      ("┄ ", A("amber", "card")), ("waiting on you  ", A("muted", "card")),
                      ("▲ ", A("amber", "card")), ("retry  ", A("muted", "card")),
                      ("◆ ", A("blue", "card")), ("decided alone", A("muted", "card"))], lane_w)
    detail(win, x, y + ph + 1, w, h, t, now, ds, sel_key)

VARIANTS = [("Pipeline", v_pipeline), ("Timeline", v_timeline), ("Focus", v_focus), ("Timeline+", v_timeline2)]

# ---------------------------------------------------------------- frame
def frame(scr, t, now, paused, ui):
    h, w = scr.getmaxyx()
    ds = [(tk, derive(tk, t)) for tk in TICKETS]
    live, past = sidebar_order(ds)
    order = [tk["key"] for tk, _ in live + past]
    if ui["sel"] not in order:
        ui["sel"] = order[0]
    sidebar(scr, h, t, now, live, past, ui["sel"], ds, paused)
    x, mw = SB + 2, w - SB - 3
    # variant tabs
    xx = x
    for i, (name, _) in enumerate(VARIANTS):
        active = i == ui["v"]
        label = f" {i + 1} {name} "
        put(scr, 1, xx, label, A("ink", "teal", True) if active else A("muted", None))
        xx += len(label) + 1
    put(scr, 1, x + mw - 26, "PROTOTYPE · fake data", A("faint", None))
    tk, d = next(x_ for x_ in ds if x_[0]["key"] == ui["sel"])
    if ui["log"]:
        ui["max_scroll"] = log_card(scr, x, 3, mw, h - 5, tk, d, t, ui["scroll"])
    else:
        VARIANTS[ui["v"]][1](scr, x, 3, mw, h - 2, t, now, ds, live, ui["sel"])
    put(scr, h - 2, x, "↑↓ ticket   enter full log   j/k scroll   1-4 / ←→ variant   space pause   q quit",
        A("faint", None))
    return order

def main(scr, v):
    curses.curs_set(0)
    curses.start_color()
    curses.use_default_colors()
    scr.timeout(80)
    scr.keypad(True)
    start, paused_at = time.time(), None
    ui = dict(v=v, sel="PIR-243", log=False, scroll=0, max_scroll=0)
    while True:
        now = time.time()
        t = ((paused_at or now) - start) % LOOP
        scr.erase()
        order = frame(scr, t, now, paused_at is not None, ui)
        scr.refresh()
        ch = scr.getch()
        if ch == ord("q"):
            if ui["log"]:
                ui["log"] = False
            else:
                return
        elif ch in (10, 13, curses.KEY_ENTER):
            ui["log"], ui["scroll"] = not ui["log"], 0
        elif ch == 27:
            ui["log"] = False
        elif ch in (ord("1"), ord("2"), ord("3"), ord("4")):
            ui["v"], ui["log"] = ch - ord("1"), False
        elif ch in (curses.KEY_RIGHT, curses.KEY_LEFT):
            ui["v"], ui["log"] = (ui["v"] + (1 if ch == curses.KEY_RIGHT else -1)) % len(VARIANTS), False
        elif ch in (curses.KEY_DOWN, curses.KEY_UP):
            i = order.index(ui["sel"]) + (1 if ch == curses.KEY_DOWN else -1)
            ui["sel"], ui["scroll"] = order[i % len(order)], 0
        elif ch == ord("k"):
            ui["scroll"] = min(ui["max_scroll"], ui["scroll"] + 1)
        elif ch == ord("j"):
            ui["scroll"] = max(0, ui["scroll"] - 1)
        elif ch == ord(" "):
            if paused_at:
                start += now - paused_at
                paused_at = None
            else:
                paused_at = now

# ======================================================================
# board + ticket views (from abt_watch_board.py)
# ======================================================================
import curses
import locale
import time


BOARD = "BOARD"
RISK_C = {"low": "green", "medium": "amber", "high": "rose"}

# ---------------------------------------------------------------- sidebar
def sidebar(win, h, t, now, live, past, sel, ds, paused):
    for y in range(h - 1):
        fill(win, y, 0, SB, "side")
    run(win, 1, 2, [("◆ ", A("teal", "side", True)), ("abt watch", A("bright", "side", True))], SB - 3)
    run(win, 2, 2, [(f"piron · {clock(t)}", A("muted", "side"))], SB - 3)
    running = sum(1 for _, d in ds if d["phase"] == "running")
    needs = sum(1 for _, d in ds if d["phase"] == "needs")
    queued = sum(1 for _, d in ds if d["phase"] == "queued") + len(BLOCKED)
    run(win, 4, 2, [("workers ", A("muted", "side")), ("●" * running, A("teal", "side", True)),
                    ("○" * (2 - running), A("faint", "side")),
                    ("  needs ", A("muted", "side")), (str(needs), A("amber" if needs else "faint", "side", True)),
                    ("  queue ", A("muted", "side")), (str(queued), A("text", "side", True))], SB - 3)
    run(win, 5, 2, [("dispatch ", A("muted", "side")),
                    ("paused" if paused else "on", A("amber" if paused else "green", "side", True))], SB - 3)
    y = 7
    # Board entry
    on = sel == BOARD
    bg = "raised" if on else "side"
    fill(win, y, 0, SB, bg)
    if on:
        put(win, y, 0, "▌", A("teal", bg))
    n_active = sum(1 for _, d in live if d["phase"] in ACTIVE)
    run(win, y, 2, [("▦ ", A("teal", bg, True)), ("Board", A("bright" if on else "text", bg, True)),
                    (f"  {n_active} active", A("muted", bg))], SB - 3)
    y += 2
    spin = SPIN[int(now * 10) % len(SPIN)]

    def row(key, title, phase):
        nonlocal y
        col = STATE[phase]
        on = key == sel
        bg = "raised" if on else "side"
        fill(win, y, 0, SB, bg); fill(win, y + 1, 0, SB, bg)
        if on:
            put(win, y, 0, "▌", A(col, bg)); put(win, y + 1, 0, "▌", A(col, bg))
        g = {"needs": "●", "running": spin, "merged": "✓", "done": "✓", "abandoned": "✕", "queued": "○"}[phase]
        gc = pulse("amber", now) if phase == "needs" else P[col]
        run(win, y, 2, [(g + " ", A(gc, bg, True)), (key, A("bright" if on else "text", bg, True)),
                        ("  " + STATE_WORD[phase].lower(), A(col if phase in ACTIVE else "muted", bg))], SB - 3)
        put(win, y + 1, 4, title[:SB - 6], A("text" if on else "muted", bg))
        y += 2

    put(win, y, 2, "NOW", A("faint", "side", True)); y += 1
    for tk, d in live:
        row(tk["key"], tk["title"], d["phase"])
    for k, title, why in BLOCKED:
        run(win, y, 2, [("○ ", A("faint", "side")), (k, A("muted", "side", True)), ("  blocked", A("faint", "side"))], SB - 3)
        put(win, y + 1, 4, title[:SB - 6], A("faint", "side"))
        y += 2
    y += 1
    put(win, y, 2, "EARLIER TODAY", A("faint", "side", True)); y += 1
    for tk, d in past:
        row(tk["key"], tk["title"], d["phase"])
    put(win, h - 3, 2, "older: abt log show <id>", A("faint", "side"))

# ---------------------------------------------------------------- shared header / footer
def card_header(win, y, x, w, tk, d, now, compact=False):
    """pill + key + title, then risk · type · grade. Returns rows used."""
    m = d["meta"]
    xx = pill(win, y, x, STATE_WORD[d["phase"]], STATE[d["phase"]], now if d["phase"] == "needs" else None)
    if compact:
        run(win, y, xx + 1, [(tk["key"], A("bright", "card", True))], w - (xx - x) - 1)
        put(win, y + 1, x, tk["title"], A("text", "card", True), w)
        yy = y + 2
    else:
        run(win, y, xx + 1, [(tk["key"], A("bright", "card", True)), ("  " + tk["title"], A("bright", "card"))], w - (xx - x) - 1)
        yy = y + 1
    risk = m.get("risk", "?")
    run(win, yy, x, [("risk ", A("muted", "card")), (risk, A(RISK_C.get(risk, "muted"), "card", True)),
                     ("  ·  ", A("line", "card")), (tk["type"], A("text", "card")),
                     ("  ·  ", A("line", "card")), (m.get("grade", "-"), A("text", "card")),
                     (f" ({grade_model(m)})" if m.get("grade") else "", A("muted", "card"))], w)
    return yy - y + 1

def grade_model(m):
    return {"simple": "Sonnet medium", "standard": "Sonnet high", "hard": "Opus high"}.get(m.get("grade"), "")

def refs(d):
    out = []
    for e in d["seen"]:
        if e[3].startswith("feature/"):
            out.append(("⎇ " + e[3], "muted"))
        if "PR #" in e[3]:
            out.append(("PR " + e[3][e[3].index("#"):].split()[0], "blue"))
    return out

def card_footer(win, y, x, w, tk, d, t):
    """time meter, tries, cost, activity sparkline; refs on a second row. Returns rows used."""
    m = d["meta"]
    cap = m.get("cap", 90)
    frac = d["elapsed"] / cap if cap else 0
    tc = "rose" if frac > .8 else "amber" if frac > .5 else "teal"
    put(win, y, x, "─" * w, A("line", "card"))
    put(win, y + 1, x, "time", A("muted", "card"))
    mw = max(6, min(16, w - 30))
    meter(win, y + 1, x + 5, frac, mw, tc if d["phase"] == "running" else "faint")
    xx = run(win, y + 1, x + 6 + mw, [(f"{int(d['elapsed'])}/{cap}m", A("muted", "card"))], 10)
    a = m.get("attempt", 0)
    xx = run(win, y + 1, xx + 2, [("tries ", A("muted", "card")), ("●" * a, A("amber" if a > 1 else "teal", "card", True)),
                                  ("○" * (6 - a), A("line", "card"))], x + w - xx - 2)
    run(win, y + 2, x, [("cost ", A("muted", "card")),
                        (f"${m['cost']:.2f}" if "cost" in m else "$ –", A("text", "card", True)),
                        (f"  {m['tokens']}k tok" if "tokens" in m else "", A("muted", "card"))], 22)
    if w > 40:
        run(win, y + 2, x + 22, [("activity ", A("muted", "card")), (spark(d, t, min(16, w - 33)), A(STATE[d["phase"]], "card"))], w - 22)
    xx = x
    for text, c in refs(d):
        xx = run(win, y + 3, xx, [(text, A(c, "card")), ("   ", 0)], x + w - xx)
    return 4

FOOT_H = 4

# ---------------------------------------------------------------- board
def board(win, x, y, w, h, t, now, live):
    active = [(tk, d) for tk, d in live if d["phase"] in ACTIVE]
    if not active:
        panel(win, y, x, 5, w, "card")
        put(win, y + 2, x + 3, "No active tickets. Queued work starts when a worker slot frees up.", A("muted", "card"))
        return
    n = len(active)
    cw = (w - (n - 1)) // n
    for i, (tk, d) in enumerate(active):
        cx = x + i * (cw + 1)
        accent = pulse("amber", now) if d["phase"] == "needs" else P[STATE[d["phase"]]]
        panel(win, y, cx, h - y, cw, "card", accent=accent)
        ix, iw = cx + 3, cw - 5
        yy = y + 1 + card_header(win, y + 1, ix, iw, tk, d, now, compact=True)
        yy += 1
        if d["phase"] == "needs":
            yy += ask_card(win, yy, ix, iw, d, now) + 1
        put(win, yy, ix, f"{tk['type']}.yaml", A("faint", "card"))
        yy += 1 + tree_rows(win, yy + 1, ix, iw, tk, d, now) + 1
        foot_y = h - FOOT_H - 1
        log_rows = foot_y - yy - 2
        if log_rows >= 2:
            put(win, yy, ix, "log", A("faint", "card"))
            for j, e in enumerate(d["seen"][-log_rows:]):
                event_row(win, yy + 1 + j, ix, iw, e, t, node=False)
        card_footer(win, foot_y, ix, iw, tk, d, t)

# ---------------------------------------------------------------- one ticket
def ticket(win, x, y, w, h, t, now, tk, d, scroll):
    accent = pulse("amber", now) if d["phase"] == "needs" else P[STATE[d["phase"]]]
    panel(win, y, x, h - y, w, "card", accent=accent)
    ix, iw = x + 3, w - 6
    yy = y + 1 + card_header(win, y + 1, ix, iw, tk, d, now)
    stepper(win, yy + 1, ix, iw, tk, d, now)
    yy += 4
    if d["phase"] == "needs":
        yy += ask_card(win, yy, ix, iw, d, now) + 1
    left = min(64, iw // 2)
    put(win, yy, ix, f"{tk['type']}.yaml", A("faint", "card"))
    tree_rows(win, yy + 1, ix, left - 2, tk, d, now)
    lx = ix + left + 1
    foot_y = h - FOOT_H - 1
    room = foot_y - yy - 2
    rows = d["seen"]
    max_scroll = max(0, len(rows) - room)
    start = max(0, max_scroll - scroll)
    put(win, yy, lx, "log", A("faint", "card"))
    if start:
        put(win, yy, lx + 6, f"↑ {start} earlier · k", A("faint", "card"))
    if scroll:
        put(win, yy, lx + 26, "following paused · j", A("amber", "card"))
    for j, e in enumerate(rows[start:start + room]):
        event_row(win, yy + 1 + j, lx, iw - left - 1, e, t)
    card_footer(win, foot_y, ix, iw, tk, d, t)
    return max_scroll

# ---------------------------------------------------------------- frame
def frame(scr, t, now, paused, ui):
    h, w = scr.getmaxyx()
    ds = [(tk, derive(tk, t)) for tk in TICKETS]
    live, past = sidebar_order(ds)
    order = [BOARD] + [tk["key"] for tk, _ in live + past]
    if ui["sel"] not in order:
        ui["sel"] = BOARD
    sidebar(scr, h, t, now, live, past, ui["sel"], ds, paused)
    x, mw = SB + 2, w - SB - 3
    if ui["sel"] == BOARD:
        crumbs = [("Board", A("bright", None, True)), ("   all active tickets", A("muted", None))]
    else:
        tk, d = next(x_ for x_ in ds if x_[0]["key"] == ui["sel"])
        crumbs = [("Board", A("muted", None)), ("  ›  ", A("faint", None)), (tk["key"], A("bright", None, True)),
                  ("  " + tk["title"], A("muted", None))]
    run(scr, 1, x, crumbs, mw - 24)
    put(scr, 1, x + mw - 22, "PROTOTYPE · fake data", A("faint", None))
    if ui["sel"] == BOARD:
        board(scr, x, 3, mw, h - 2, t, now, live)
        ui["max_scroll"] = 0
    else:
        ui["max_scroll"] = ticket(scr, x, 3, mw, h - 2, t, now, tk, d, ui["scroll"])
    put(scr, h - 2, x, "↑↓ navigate   b board   j/k scroll log   space pause   q quit", A("faint", None))
    return order

def main(scr):
    curses.curs_set(0)
    curses.start_color()
    curses.use_default_colors()
    scr.timeout(80)
    scr.keypad(True)
    start, paused_at = time.time(), None
    ui = dict(sel=BOARD, scroll=0, max_scroll=0)
    while True:
        now = time.time()
        t = ((paused_at or now) - start) % LOOP
        scr.erase()
        order = frame(scr, t, now, paused_at is not None, ui)
        scr.refresh()
        ch = scr.getch()
        if ch == ord("q"):
            return
        if ch in (ord("b"), 27):
            ui["sel"], ui["scroll"] = BOARD, 0
        elif ch in (curses.KEY_DOWN, curses.KEY_UP):
            i = order.index(ui["sel"]) + (1 if ch == curses.KEY_DOWN else -1)
            ui["sel"], ui["scroll"] = order[i % len(order)], 0
        elif ch == ord("k"):
            ui["scroll"] = min(ui["max_scroll"], ui["scroll"] + 1)
        elif ch == ord("j"):
            ui["scroll"] = max(0, ui["scroll"] - 1)
        elif ch == ord(" "):
            if paused_at:
                start += now - paused_at
                paused_at = None
            else:
                paused_at = now

if __name__ == "__main__":
    locale.setlocale(locale.LC_ALL, "")
    curses.wrapper(main)
