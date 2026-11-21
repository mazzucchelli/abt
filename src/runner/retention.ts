import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";

/** Per-run transcripts are pruned this long after a ticket's terminal state. Decision logs are never pruned. */
export const TRANSCRIPT_RETENTION_DAYS = 30;

const MARKER = ".terminal";
const TICKET = /^[A-Za-z0-9._-]+$/;

/**
 * Retention for per-run transcripts, which live in `<runsDir>/<ticket>/`. The runner stamps a ticket's
 * folder when it sees the ticket in a terminal state (Done or Abandoned) and clears the stamp if the
 * ticket is active again; `prune` removes the folders stamped more than 30 days ago. A folder with no stamp is never touched, and
 * nothing here knows where decision logs live, so they cannot be pruned.
 */
export class TranscriptRetention {
  readonly #runsDir: string;
  readonly #clock: Clock;

  constructor(deps: { runsDir: string; clock: Clock }) {
    this.#runsDir = deps.runsDir;
    this.#clock = deps.clock;
  }

  #dir(ticket: string): string {
    if (!TICKET.test(ticket) || ticket === "." || ticket === "..") throw new Error(`invalid ticket id ${JSON.stringify(ticket)}`);
    return join(this.#runsDir, ticket);
  }

  /** Tickets with transcripts, and when each reached a terminal state (undefined: not terminal). */
  tickets(): { ticket: string; since: Date | undefined }[] {
    if (!existsSync(this.#runsDir)) return [];
    return readdirSync(this.#runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && TICKET.test(e.name))
      .map((e) => ({ ticket: e.name, since: this.#since(e.name) }));
  }

  #since(ticket: string): Date | undefined {
    try {
      const at = new Date(readFileSync(join(this.#dir(ticket), MARKER), "utf8").trim());
      return Number.isNaN(at.getTime()) ? undefined : at;
    } catch {
      return undefined;
    }
  }

  /** Starts the 30 days for a ticket now in a terminal state. A ticket already on the clock keeps its start. */
  markTerminal(ticket: string): void {
    const dir = this.#dir(ticket);
    if (this.#since(ticket) !== undefined) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), this.#clock.now().toISOString());
  }

  /** The ticket is active again: its transcripts are no longer on the clock. */
  clearTerminal(ticket: string): void {
    rmSync(join(this.#dir(ticket), MARKER), { force: true });
  }

  /** Removes the transcripts of tickets whose terminal state is more than 30 days old. Returns those tickets. */
  prune(): string[] {
    const cutoff = this.#clock.now().getTime() - TRANSCRIPT_RETENTION_DAYS * 86_400_000;
    const pruned: string[] = [];
    for (const { ticket, since } of this.tickets()) {
      if (since === undefined || since.getTime() >= cutoff) continue;
      rmSync(this.#dir(ticket), { recursive: true, force: true });
      pruned.push(ticket);
    }
    return pruned.sort();
  }
}
