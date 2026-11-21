import type { CheckName, CodeHost, CodeHostFacts, CommitStatus, OpenPr, PrHost } from "./contract.ts";

/** In-memory CodeHost for tests. Facts are set from outside; writes change them. */
export class FakeCodeHost implements CodeHost, PrHost {
  #facts = new Map<string, CodeHostFacts>();
  #prs: { pr: OpenPr; contents: Record<string, string> }[] = [];
  /** Every status posted, in order. */
  readonly statuses: { sha: string; status: CommitStatus }[] = [];

  /** An open PR whose changed files are exactly `contents`' keys; a value is the file's content at head. */
  addPr(headSha: string, contents: Record<string, string | null>, number = this.#prs.length + 1): OpenPr {
    const pr: OpenPr = { number, url: `https://fake.host/pr/${number}`, headSha, files: Object.keys(contents) };
    const present = Object.fromEntries(Object.entries(contents).filter((e): e is [string, string] => e[1] !== null));
    this.#prs.push({ pr, contents: present });
    return pr;
  }

  async openPrs(): Promise<OpenPr[]> {
    return this.#prs.map((p) => structuredClone(p.pr));
  }

  async readFile(pr: OpenPr, path: string): Promise<string | undefined> {
    return this.#prs.find((p) => p.pr.number === pr.number)?.contents[path];
  }

  async postStatus(sha: string, status: CommitStatus): Promise<void> {
    this.statuses.push({ sha, status });
  }

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

  async openPr(ticket: string): Promise<string> {
    const f = this.#get(ticket);
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
