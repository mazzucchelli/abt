import { HeadMovedError, type CheckName, type CodeHost, type CodeHostFacts, type CommitStatus, type JobResult, type MainHost, type OpenPr, type PrHost } from "./contract.ts";

/** In-memory CodeHost for tests. Facts are set from outside; writes change them. */
export class FakeCodeHost implements CodeHost, PrHost, MainHost {
  #facts = new Map<string, CodeHostFacts>();
  #prs: { pr: OpenPr; contents: Record<string, string> }[] = [];
  /** Test hooks: run just before facts are read, and just before a merge is attempted. */
  onRead?: (ticket: string) => void;
  beforeMerge?: (ticket: string) => void;
  /** Every merge that went through, with the head it matched. */
  readonly merges: { ticket: string; sha: string }[] = [];
  /** Every PR closed unmerged, by ticket. */
  readonly closed: string[] = [];
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
    this.onRead?.(ticket);
    return structuredClone(this.#get(ticket));
  }

  async openPr(ticket: string, body?: string): Promise<string> {
    const f = this.#get(ticket);
    if (body !== undefined) this.prBodies.set(ticket, body);
    f.pr ??= `https://fake.host/${ticket}/pr/1`;
    return f.pr;
  }

  async closePr(ticket: string): Promise<void> {
    const f = this.#get(ticket);
    if (f.merged) throw new Error(`${ticket}: the PR is merged and cannot be closed`);
    if (f.pr === undefined) return;
    delete f.pr;
    this.closed.push(ticket);
  }

  /** CI on the default branch, by merge commit; set from outside. */
  readonly #main = new Map<string, Record<string, JobResult>>();
  /** Every revert PR opened, never merged. */
  readonly reverts: { sha: string; title: string; body: string; url: string }[] = [];

  /** The merge commit abt's merge of a PR made, for the PR's head SHA. */
  static mergeShaOf(headSha: string): string {
    return `merge-of-${headSha}`;
  }

  setMainJob(sha: string, job: string, state: JobResult["state"]): void {
    this.#main.set(sha, { ...this.#main.get(sha), [job]: { state, sha } });
  }

  async mainJobs(sha: string): Promise<Record<string, JobResult>> {
    return structuredClone(this.#main.get(sha) ?? {});
  }

  async openRevertPr(sha: string, pr: { title: string; body: string }): Promise<string> {
    const url = `https://fake.host/revert/${this.reverts.length + 1}`;
    this.reverts.push({ sha, ...pr, url });
    return url;
  }

  async merge(ticket: string, opts: { matchHeadSha: string }): Promise<string> {
    this.beforeMerge?.(ticket);
    const f = this.#get(ticket);
    if (f.headSha !== opts.matchHeadSha) throw new HeadMovedError(`head is ${f.headSha ?? "unknown"}, not ${opts.matchHeadSha}`);
    f.merged = true;
    this.merges.push({ ticket, sha: opts.matchHeadSha });
    return FakeCodeHost.mergeShaOf(opts.matchHeadSha);
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
