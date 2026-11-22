import { BOARD, navOrder, type Ui } from "./render.ts";
import type { Snapshot } from "./model.ts";

/** One keypress (as the terminal sends it) applied to the UI state, or "quit". Pure. */
export function reduce(ui: Ui, key: string, snap: Snapshot): Ui | "quit" {
  const order = navOrder(snap);
  const at = Math.max(0, order.indexOf(ui.sel));
  const go = (i: number): Ui => ({ ...ui, sel: order[(i + order.length) % order.length]!, scroll: 0 });
  switch (key) {
    case "q":
    case "\x03":
      return "quit";
    case "\x1b[B":
      return go(at + 1);
    case "\x1b[A":
      return go(at - 1);
    case "b":
    case "\x1b":
      return { ...ui, sel: BOARD, scroll: 0 };
    case "k": {
      const t = snap.tickets.find((x) => x.key === ui.sel);
      return { ...ui, scroll: Math.min(Math.max(0, (t?.events.length ?? 1) - 1), ui.scroll + 1) };
    }
    case "j":
      return { ...ui, scroll: Math.max(0, ui.scroll - 1) };
    case " ":
      return { ...ui, paused: !ui.paused };
    default:
      return ui;
  }
}
