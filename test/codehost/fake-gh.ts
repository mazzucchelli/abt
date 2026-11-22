import type { Exec } from "../../src/codehost/exec.ts";

interface Pr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  head: string;
  base: string;
  title: string;
  body: string;
  mergeCommit?: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  files: string[];
}

export interface Review {
  user: { login: string; type: string } | null;
  state: string;
  commit_id: string;
}

const gherr = (msg: string) => Object.assign(new Error(`gh failed: ${msg}`), { stderr: msg });

/** A tiny GitHub behind the `gh` command line: just the endpoints the code host uses. The test sets the world; calls are recorded. */
export class FakeGh {
  readonly slug = "me/sandbox";
  readonly base = "main";
  readonly calls: string[][] = [];
  #prs: Pr[] = [];
  #heads = new Map<string, string>();
  #n = 0;
  readonly reviews = new Map<number, Review[]>();
  readonly checkRuns = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  readonly statuses = new Map<string, { context: string; state: string; description: string }[]>();
  readonly files = new Map<string, string>();
  /** SHAs the base is ahead of, by head SHA: how far behind each head is. */
  readonly behind = new Map<string, number>();
  /** Runs once, just before a merge is evaluated: the place to move a head under the host's feet. */
  beforeMerge?: () => void;
  /** How many `pr view` reads of a merged PR still show no merge commit. */
  hideMergeCommitReads = 0;
  /** Replaces what a command's stdout would be, matched by prefix of the command line, to feed malformed JSON. */
  override?: (line: string) => string | undefined;

  pushBranch(branch: string): string {
    const sha = `${branch.replaceAll("/", "_")}@${++this.#n}`;
    this.#heads.set(branch, sha);
    return sha;
  }
  headOf(branch: string): string | undefined {
    return this.#heads.get(branch);
  }
  pr(n: number): Pr {
    return this.#prs.find((p) => p.number === n)!;
  }
  addFilesTo(n: number, ...paths: string[]): void {
    this.pr(n).files.push(...paths);
  }

  exec: Exec = async (cmd, args) => {
    this.calls.push([cmd, ...args]);
    if (cmd !== "gh") throw new Error(`unexpected command ${cmd}`);
    const line = ["gh", ...args].join(" ");
    const o = this.override?.(line);
    if (o !== undefined) return o;
    const opt = (name: string) => args[args.indexOf(name) + 1]!;
    const [a, b] = args;
    if (a === "pr" && b === "list") {
      const head = args.includes("--head") ? opt("--head") : undefined;
      const state = opt("--state");
      const rows = this.#prs.filter((p) => (head === undefined || p.head === head) && (state === "all" || p.state.toLowerCase() === state));
      return JSON.stringify(rows.map((p) => ({ number: p.number, url: this.#url(p), state: p.state, headRefOid: this.#heads.get(p.head), baseRefName: p.base, mergeable: p.mergeable, mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null, files: p.files.map((path) => ({ path })) })));
    }
    if (a === "pr" && b === "create") {
      const p: Pr = { number: this.#prs.length + 1, state: "OPEN", head: opt("--head"), base: opt("--base"), title: opt("--title"), body: opt("--body"), mergeable: "MERGEABLE", files: [] };
      if (!this.#heads.has(p.head)) throw gherr(`Head sha can't be blank, Base sha can't be blank, No commits between ${p.base} and ${p.head}`);
      this.#prs.push(p);
      return `${this.#url(p)}\n`;
    }
    if (a === "pr" && b === "close") {
      this.pr(Number(args[2])).state = "CLOSED";
      return "";
    }
    if (a === "pr" && b === "view") {
      const p = this.pr(Number(args[2]));
      const hide = p.state === "MERGED" && this.hideMergeCommitReads-- > 0;
      return JSON.stringify({ number: p.number, url: this.#url(p), state: p.state, headRefOid: this.#heads.get(p.head), baseRefName: p.base, mergeCommit: p.mergeCommit && !hide ? { oid: p.mergeCommit } : null });
    }
    if (a === "pr" && b === "merge") {
      this.beforeMerge?.();
      const p = this.pr(Number(args[2]));
      if (!args.includes("--squash")) throw gherr("merge method required");
      if (args.includes("--match-head-commit") && opt("--match-head-commit") !== this.#heads.get(p.head)) throw gherr("Pull request Head branch was modified. Review and try the merge again.");
      p.state = "MERGED";
      p.mergeCommit = `squash-${p.number}`;
      return "";
    }
    if (a === "api") return this.#api(args);
    throw new Error(`unexpected gh command: ${line}`);
  };

  #url(p: Pr): string {
    return `https://github.com/${this.slug}/pull/${p.number}`;
  }

  #api(args: string[]): string {
    const path = args[1]!.replace(`repos/${this.slug}/`, "");
    const slurp = args.includes("--slurp");
    const page = (x: unknown) => JSON.stringify(slurp ? [x] : x);
    let m: RegExpExecArray | null;
    if ((m = /^pulls\/(\d+)\/reviews/.exec(path))) return JSON.stringify([this.reviews.get(Number(m[1])) ?? []]);
    if ((m = /^commits\/([^/]+)\/check-runs/.exec(path))) {
      const runs = this.checkRuns.get(m[1]!) ?? [];
      return page({ total_count: runs.length, check_runs: runs });
    }
    if ((m = /^commits\/([^/]+)\/status/.exec(path))) return JSON.stringify({ state: "pending", statuses: this.statuses.get(m[1]!) ?? [] });
    if ((m = /^compare\/([^.]+)\.\.\.([^?]+)/.exec(path))) return JSON.stringify({ behind_by: this.behind.get(m[2]!) ?? 0, ahead_by: 1 });
    if ((m = /^statuses\/([^?]+)/.exec(path))) {
      if (args[args.indexOf("-X") + 1] !== "POST") throw new Error("statuses needs POST");
      const f = (k: string) => args.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1);
      const list = this.statuses.get(m[1]!) ?? [];
      this.statuses.set(m[1]!, [...list.filter((s) => s.context !== f("context")), { context: f("context")!, state: f("state")!, description: f("description")! }]);
      return "{}";
    }
    if ((m = /^contents\/([^?]+)\?ref=(.+)$/.exec(path))) {
      const content = this.files.get(`${m[2]}:${decodeURIComponent(m[1]!)}`);
      if (content === undefined) throw gherr("Not Found (HTTP 404)");
      return JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    throw new Error(`unexpected gh api path: ${path}`);
  }
}
