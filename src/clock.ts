/** Time source. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Repeating timers, so the runner's poll, scan and heartbeat can be driven by a fake clock. */
export interface Timers {
  /** Calls `fn` every `ms`. Returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
}

export const systemTimers: Timers = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref();
    return () => clearInterval(t);
  },
};

/** Controllable clock for tests: fixed until advanced. */
export class FakeClock implements Clock, Timers {
  #ms: number;
  #timers = new Set<{ next: number; ms: number; fn: () => void }>();

  constructor(start: string | Date = "2026-01-01T00:00:00.000Z") {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** Moves time forward, firing every timer that falls due on the way, in time order. */
  advance(ms: number): void {
    const target = this.#ms + ms;
    for (;;) {
      const due = [...this.#timers].filter((t) => t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      this.#ms = due.next;
      due.next += due.ms;
      due.fn();
    }
    this.#ms = target;
  }

  every(ms: number, fn: () => void): () => void {
    const timer = { next: this.#ms + ms, ms, fn };
    this.#timers.add(timer);
    return () => void this.#timers.delete(timer);
  }
}
