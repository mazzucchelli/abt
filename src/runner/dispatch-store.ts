import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DispatchStatus = "claimed" | "running" | "retrying" | "released";

export interface DispatchEntry {
  status: DispatchStatus;
  since: string;
}

/**
 * The runner's private, disposable dispatch state. It is a cache of what the runner has been
 * doing, never a source of truth: on start the runner clears it and rebuilds it from the tracker,
 * so deleting it changes nothing about what gets scheduled.
 */
export class DispatchStore {
  readonly #file: string | undefined;
  #entries = new Map<string, DispatchEntry>();

  /** With a file the store survives the process; without one it is memory only. */
  constructor(file?: string) {
    this.#file = file;
    if (!file) return;
    try {
      this.#entries = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, DispatchEntry>));
    } catch {
      // Missing or unreadable is the same as empty: the store is disposable.
    }
  }

  get(key: string): DispatchEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, entry: DispatchEntry): void {
    this.#entries.set(key, entry);
    this.#save();
  }

  entries(): [string, DispatchEntry][] {
    return [...this.#entries];
  }

  clear(): void {
    this.#entries.clear();
    this.#save();
  }

  #save(): void {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    if (this.#entries.size === 0) rmSync(this.#file, { force: true });
    else writeFileSync(this.#file, JSON.stringify(Object.fromEntries(this.#entries)));
  }
}
