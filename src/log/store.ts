import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import { isDecisionRecord, validateRecord, type DecisionRecord, type RecordInput } from "./record.ts";

export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogError";
  }
}

/** The global abt folder: $ABT_HOME, else ~/.local/state/abt. */
export function abtHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ABT_HOME ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "abt");
}

/** The decision log: one append-only JSONL file per ticket. */
export class DecisionLog {
  readonly #home: string;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(home: string, clock: Clock, newId: () => string) {
    this.#home = home;
    this.#clock = clock;
    this.#newId = newId;
  }

  /** The log's clock, so durations are measured on the same time the records are stamped with. */
  now(): Date {
    return this.#clock.now();
  }

  path(ticket: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) throw new LogError(`invalid ticket id ${JSON.stringify(ticket)}`);
    return join(this.#home, "log", `${ticket}.jsonl`);
  }

  read(ticket: string): DecisionRecord[] {
    const file = this.path(ticket);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l, i) => {
        const record: unknown = JSON.parse(l);
        if (!isDecisionRecord(record)) throw new LogError(`${file}: record ${i + 1} is not a valid decision record: ${validateRecord(record).join("; ")}`);
        return record;
      });
  }

  append(ticket: string, input: RecordInput): DecisionRecord {
    const record = { ...input, id: this.#newId(), timestamp: this.#clock.now().toISOString(), ticket } as DecisionRecord;
    const problems = validateRecord(record);
    if (problems.length > 0) throw new LogError(`invalid decision record: ${problems.join("; ")}`);
    if (record.supersedes !== undefined && !this.read(ticket).some((r) => r.id === record.supersedes)) {
      throw new LogError(`cannot supersede ${record.supersedes}: no such record for ${ticket}`);
    }
    const file = this.path(ticket);
    mkdirSync(join(this.#home, "log"), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
    return record;
  }
}
