import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig } from "../runner/config.ts";
import { loadLaunchProfile } from "../harness/claude/profile.ts";
import { abtHome } from "../log/store.ts";
import { reduce } from "./keys.ts";
import { loadSnapshot, type Snapshot } from "./model.ts";
import { BOARD, render, type Ui } from "./render.ts";

/** Where the watcher reads from: the decision log under the abt folder and the worker transcripts under the runs dir. */
export function sources(env: NodeJS.ProcessEnv = process.env) {
  const home = abtHome(env);
  const runsDir = loadLaunchProfile({ home: homedir(), pluginDir: fileURLToPath(new URL("../..", import.meta.url)) }).runsDir;
  let wallClockMinutes: Record<string, number> | undefined;
  try {
    wallClockMinutes = loadGlobalConfig(home).scheduling.wallClockMinutes as Record<string, number> | undefined;
  } catch {
    // a broken config only costs the caps
  }
  return { home, runsDir, ...(wallClockMinutes && { wallClockMinutes }) };
}

/** `abt watch`: the live board. Read-only: it opens files for reading and writes only to the terminal. */
export async function watchCommand(args: string[]): Promise<number> {
  const src = sources();
  if (args.includes("--once")) {
    const width = Number(process.env.COLUMNS) || 120;
    const height = Number(process.env.LINES) || 40;
    const snap = await loadSnapshot({ ...src, now: Date.now() });
    const sel = args.find((a) => !a.startsWith("--")) ?? BOARD;
    console.log(render(snap, { sel, scroll: 0, paused: false }, { width, height, now: Date.now(), color: false }).join("\n"));
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("abt watch needs a terminal; use `abt watch --once` for a single frame");
    return 2;
  }
  const out = process.stdout;
  let snap: Snapshot = { now: Date.now(), tickets: [] };
  let ui: Ui = { sel: BOARD, scroll: 0, paused: false };
  let loading = false;
  const refresh = async () => {
    if (loading || ui.paused) return;
    loading = true;
    try {
      snap = await loadSnapshot({ ...src, now: Date.now() });
    } catch {
      // a file mid-write: keep the last snapshot, the next tick tries again
    } finally {
      loading = false;
    }
  };
  const draw = () => {
    const lines = render(snap, ui, { width: out.columns ?? 120, height: out.rows ?? 40, now: Date.now(), color: true });
    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}`);
  };

  // Leave the terminal usable however the process ends.
  const restore = () => out.write("\x1b[?25h\x1b[?1049l");
  process.once("exit", restore);
  out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  await refresh();
  draw();

  return new Promise<number>((resolve) => {
    const poll = setInterval(() => void refresh(), 1000);
    const frame = setInterval(draw, 100);
    const stop = () => {
      clearInterval(poll);
      clearInterval(frame);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onKey);
      out.off("resize", draw);
      process.off("exit", restore);
      restore();
      resolve(0);
    };
    const onKey = (chunk: string) => {
      // A held key or a paste arrives as one chunk of several keys.
      for (const key of chunk.match(/\x1b\[[A-D]|[\s\S]/gu) ?? []) {
        const next = reduce(ui, key, snap);
        if (next === "quit") return stop();
        const resumed = ui.paused && !next.paused;
        ui = next;
        if (resumed) void refresh();
      }
      draw();
    };
    process.stdin.on("data", onKey);
    out.on("resize", () => {
      out.write("\x1b[2J");
      draw();
    });
  });
}
