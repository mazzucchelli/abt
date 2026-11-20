/** Time source. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests: fixed until advanced. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: string | Date = "2026-01-01T00:00:00.000Z") {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}
