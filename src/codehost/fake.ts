import type { CheckName, CodeHost, CodeHostFacts } from "./contract.ts";

/** In-memory CodeHost for tests. Facts are set from outside; writes change them. */
export class FakeCodeHost implements CodeHost {
  #facts = new Map<string, CodeHostFacts>();
  /** The description each PR was opened with. */
  readonly prBodies = new Map<string, string>();

  setFacts(ticket: string, facts: Partial<CodeHostFacts>): void {
    const cur = this.#get(ticket);
    this.#facts.set(ticket, { ...cur, ...facts, checks: { ...cur.checks, ...facts.checks } });
  }

  setCheck(ticket: string, name: CheckName, value: boolean): void {
    this.#get(ticket).checks[name] = value;
  }

  async readFacts(ticket: string): Promise<CodeHostFacts> {
    return structuredClone(this.#get(ticket));
  }

  async openPr(ticket: string, body?: string): Promise<string> {
    const f = this.#get(ticket);
    if (body !== undefined) this.prBodies.set(ticket, body);
    f.pr ??= `https://fake.host/${ticket}/pr/1`;
    return f.pr;
  }

  async merge(ticket: string): Promise<void> {
    this.#get(ticket).merged = true;
  }

  #get(ticket: string): CodeHostFacts {
    let f = this.#facts.get(ticket);
    if (!f) {
      f = { merged: false, checks: {} };
      this.#facts.set(ticket, f);
    }
    return f;
  }
}
