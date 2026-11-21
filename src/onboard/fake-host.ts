import type { DefaultBranchFiles, OnboardHost, OnboardPr, OpenedPr, PrState } from "./host.ts";

/** An in-memory code host: opened PRs, a default branch that only a hand merge changes, and the files on it. */
export class FakeOnboardHost implements OnboardHost, DefaultBranchFiles {
  readonly opened: OnboardPr[] = [];
  readonly #states = new Map<number, PrState>();
  readonly #main = new Map<string, string>();
  readonly #commits = new Map<string, Map<string, string>>();

  constructor(main: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(main)) this.#main.set(p, c);
  }

  async openPr(pr: OnboardPr): Promise<OpenedPr> {
    this.opened.push(structuredClone(pr));
    const number = this.opened.length;
    this.#states.set(number, { state: "open" });
    return { number, url: `https://fake.host/pr/${number}` };
  }

  async readState(number: number): Promise<PrState> {
    const s = this.#states.get(number);
    if (!s) throw new Error(`no PR ${number}`);
    return s;
  }

  /** The human merging the PR by hand: its files land on the default branch. */
  handMerge(number: number): void {
    const pr = this.opened[number - 1];
    if (!pr) throw new Error(`no PR ${number}`);
    for (const [p, c] of Object.entries(pr.files)) this.#main.set(p, c);
    this.#commits.set(`merge-${number}`, new Map(this.#main));
    this.#states.set(number, { state: "merged", mergeCommit: `merge-${number}` });
  }

  /** The PR closed without merging. */
  closePr(number: number): void {
    this.#states.set(number, { state: "closed" });
  }

  /** Someone changing a file on the default branch outside any pin. */
  commit(path: string, content: string): void {
    this.#main.set(path, content);
  }

  at(commit: string): DefaultBranchFiles {
    const snap = this.#commits.get(commit);
    if (!snap) throw new Error(`no commit ${commit}`);
    return new FakeOnboardHost(Object.fromEntries(snap));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#main.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async read(path: string): Promise<string | undefined> {
    return this.#main.get(path);
  }
}
