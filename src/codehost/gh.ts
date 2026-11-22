import { HeadMovedError, type CodeHost, type CodeHostFacts, type CommitStatus, type JobResult, type OpenPr, type PrHost } from "./contract.ts";
import { errorText, systemExec, type Exec } from "./exec.ts";

/** A `gh` answer that is not the shape its call promises. Nothing downstream ever sees a guessed value. */
export class GhShapeError extends Error {
  constructor(call: string, why: string) {
    super(`gh ${call}: ${why}`);
    this.name = "GhShapeError";
  }
}

// ---- The boundary: every gh JSON response is parsed here, into the types the rest of the module uses.

type Obj = Record<string, unknown>;

const json = (call: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new GhShapeError(call, "the response is not JSON");
  }
};
const obj = (call: string, v: unknown, at: string): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new GhShapeError(call, `${at} is not an object`);
  return v as Obj;
};
const arr = (call: string, v: unknown, at: string): unknown[] => {
  if (!Array.isArray(v)) throw new GhShapeError(call, `${at} is not an array`);
  return v;
};
const str = (call: string, o: Obj, k: string): string => {
  if (typeof o[k] !== "string") throw new GhShapeError(call, `${k} is not a string`);
  return o[k];
};
const int = (call: string, o: Obj, k: string): number => {
  if (typeof o[k] !== "number" || !Number.isInteger(o[k])) throw new GhShapeError(call, `${k} is not an integer`);
  return o[k];
};
/** `--paginate --slurp` answers with one element per page. */
const pages = (call: string, text: string): unknown[] => arr(call, json(call, text), "the response");

export type PrStateName = "open" | "closed" | "merged";

export interface PrRow {
  number: number;
  url: string;
  state: PrStateName;
  headSha: string;
  baseBranch: string;
  mergeCommit?: string;
  /** Only when the call asked for `mergeable`; GitHub answers UNKNOWN until it has worked it out. */
  mergeable?: boolean;
}

const STATES: Record<string, PrStateName> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const MERGEABLE: Record<string, boolean | undefined> = { MERGEABLE: true, CONFLICTING: false, UNKNOWN: undefined };

function prRow(call: string, v: unknown): PrRow {
  const o = obj(call, v, "a PR");
  const state = STATES[str(call, o, "state")];
  if (!state) throw new GhShapeError(call, `unknown PR state ${String(o["state"])}`);
  const mc = o["mergeCommit"];
  const mergeCommit = mc === null || mc === undefined ? undefined : str(call, obj(call, mc, "mergeCommit"), "oid");
  let mergeable: boolean | undefined;
  if (o["mergeable"] !== undefined) {
    const m = str(call, o, "mergeable");
    if (!(m in MERGEABLE)) throw new GhShapeError(call, `unknown mergeable ${m}`);
    mergeable = MERGEABLE[m];
  }
  return { number: int(call, o, "number"), url: str(call, o, "url"), state, headSha: str(call, o, "headRefOid"), baseBranch: str(call, o, "baseRefName"), ...(mergeCommit !== undefined && { mergeCommit }), ...(mergeable !== undefined && { mergeable }) };
}

function openPrRow(call: string, v: unknown): OpenPr {
  const o = obj(call, v, "a PR");
  const files = arr(call, o["files"], "files").map((f) => str(call, obj(call, f, "a file"), "path"));
  return { number: int(call, o, "number"), url: str(call, o, "url"), headSha: str(call, o, "headRefOid"), files };
}

const jobState = (conclusion: string | null, status: string): JobResult["state"] => {
  if (status !== "completed") return "pending";
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" ? "success" : "failure";
};
const statusState = (s: string): JobResult["state"] => (s === "success" ? "success" : s === "pending" ? "pending" : "failure");
const RANK: Record<JobResult["state"], number> = { success: 0, pending: 1, failure: 2 };

// ---- PR operations shared with onboarding, so no one else needs to shell out to `gh pr`.

interface Where {
  /** `owner/name`; without it gh reads the repository from `cwd`. */
  repo?: string;
  cwd?: string;
}
const where = (w: Where) => (w.repo ? ["--repo", w.repo] : []);
const cwd = (w: Where) => (w.cwd === undefined ? undefined : { cwd: w.cwd });

/** Opens a PR from an already pushed branch and returns its number and URL. */
export async function createPr(exec: Exec, w: Where & { base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
  const url = (await exec("gh", ["pr", "create", ...where(w), "--base", w.base, "--head", w.head, "--title", w.title, "--body", w.body], cwd(w))).trim();
  const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new GhShapeError("pr create", `did not return a PR URL: ${url}`);
  return { number, url };
}

/** What became of a PR. */
export async function readPrState(exec: Exec, number: number, w: Where = {}): Promise<PrRow> {
  const call = `pr view ${number}`;
  const out = await exec("gh", ["pr", "view", String(number), ...where(w), "--json", "number,url,state,mergeCommit,headRefOid,baseRefName"], cwd(w));
  return prRow(call, json(call, out));
}

// ---- The code host.

export interface GhCodeHostOptions {
  /** `owner/name`. */
  repo: string;
  defaultBranch: string;
  /** The ticket's branch and PR title. The branch is pushed by the worker; this host never pushes. */
  locate(ticket: string): { branch: string; title: string } | Promise<{ branch: string; title: string }>;
  exec?: Exec;
  /** Delay between reads of a just-merged PR for its merge commit. */
  mergeCommitRetryMs?: number;
}

const DESCRIPTION_CAP = 140;
const MERGE_COMMIT_ATTEMPTS = 5;
const LIST_FIELDS = "number,url,state,headRefOid,baseRefName,mergeCommit,mergeable";

/** The code host over `gh`: facts, the PR's life and the `abt/validate` status. The default branch's side (MainHost) is not here. */
export class GhCodeHost implements CodeHost, PrHost {
  readonly #repo: string;
  readonly #base: string;
  readonly #locate: GhCodeHostOptions["locate"];
  readonly #exec: Exec;
  readonly #retryMs: number;

  constructor(o: GhCodeHostOptions) {
    this.#repo = o.repo;
    this.#base = o.defaultBranch;
    this.#locate = o.locate;
    this.#exec = o.exec ?? systemExec;
    this.#retryMs = o.mergeCommitRetryMs ?? 1000;
  }

  #gh(...args: string[]): Promise<string> {
    return this.#exec("gh", args);
  }
  #api(path: string, ...extra: string[]): Promise<string> {
    return this.#gh("api", `repos/${this.#repo}/${path}`, ...extra);
  }

  /** The ticket's open PR, else its merged one. A closed PR is no PR. */
  async #find(branch: string): Promise<PrRow | undefined> {
    const call = "pr list";
    const out = await this.#gh("pr", "list", "--repo", this.#repo, "--head", branch, "--state", "all", "--limit", "100", "--json", LIST_FIELDS);
    const rows = arr(call, json(call, out), "the response").map((r) => prRow(call, r));
    return rows.find((r) => r.state === "open") ?? rows.filter((r) => r.state === "merged").sort((a, b) => b.number - a.number)[0];
  }

  async readFacts(ticket: string): Promise<CodeHostFacts> {
    const pr = await this.#find((await this.#locate(ticket)).branch);
    if (!pr) return { merged: false, checks: {} };
    if (pr.state === "merged") return { pr: pr.url, merged: true, headSha: pr.headSha, checks: {} };
    const [approvals, jobs, behind] = await Promise.all([this.#approvals(pr), this.#jobs(pr.headSha), this.#behindBy(pr)]);
    return { pr: pr.url, merged: false, headSha: pr.headSha, approvals, jobs, checks: { "branch-up-to-date": behind === 0 }, ...(pr.mergeable !== undefined && { mergeable: pr.mergeable }) };
  }

  /** Human approvals on the current head: each reviewer's latest verdict, if it is an approval of this commit. Bots do not count. */
  async #approvals(pr: PrRow): Promise<number> {
    const call = `pulls/${pr.number}/reviews`;
    const verdict = new Map<string, { state: string; commit: string }>();
    for (const page of pages(call, await this.#api(`pulls/${pr.number}/reviews?per_page=100`, "--paginate", "--slurp"))) {
      for (const r of arr(call, page, "a page")) {
        const o = obj(call, r, "a review");
        if (o["user"] === null) continue;
        const user = obj(call, o["user"], "user");
        if (str(call, user, "type") !== "User") continue;
        const state = str(call, o, "state");
        if (state === "COMMENTED" || state === "PENDING") continue;
        verdict.set(str(call, user, "login"), { state, commit: str(call, o, "commit_id") });
      }
    }
    return [...verdict.values()].filter((v) => v.state === "APPROVED" && v.commit === pr.headSha).length;
  }

  /** Check runs and commit statuses on the head, by name; a name reported twice keeps its worst result. */
  async #jobs(sha: string): Promise<Record<string, JobResult>> {
    const jobs: Record<string, JobResult> = {};
    const add = (name: string, state: JobResult["state"]) => {
      const cur = jobs[name];
      if (!cur || RANK[state] > RANK[cur.state]) jobs[name] = { state, sha };
    };
    const runs = `commits/${sha}/check-runs`;
    for (const page of pages(runs, await this.#api(`${runs}?per_page=100`, "--paginate", "--slurp"))) {
      for (const r of arr(runs, obj(runs, page, "a page")["check_runs"], "check_runs")) {
        const o = obj(runs, r, "a check run");
        const conclusion = o["conclusion"] === null || o["conclusion"] === undefined ? null : str(runs, o, "conclusion");
        add(str(runs, o, "name"), jobState(conclusion, str(runs, o, "status")));
      }
    }
    const combined = `commits/${sha}/status`;
    for (const s of arr(combined, obj(combined, json(combined, await this.#api(`${combined}?per_page=100`)), "the response")["statuses"], "statuses")) {
      const o = obj(combined, s, "a status");
      add(str(combined, o, "context"), statusState(str(combined, o, "state")));
    }
    return jobs;
  }

  /** How many commits the PR's base is ahead of its head. */
  async #behindBy(pr: PrRow): Promise<number> {
    const call = "compare";
    return int(call, obj(call, json(call, await this.#api(`compare/${pr.baseBranch}...${pr.headSha}`)), "the response"), "behind_by");
  }

  async openPr(ticket: string, body?: string): Promise<string> {
    const { branch, title } = await this.#locate(ticket);
    const pr = await this.#find(branch);
    if (pr?.state === "open") return pr.url;
    if (pr) throw new Error(`${ticket}: its PR is merged, so no new one is opened`);
    return (await createPr(this.#exec, { repo: this.#repo, base: this.#base, head: branch, title, body: body ?? "" })).url;
  }

  async closePr(ticket: string): Promise<void> {
    const pr = await this.#find((await this.#locate(ticket)).branch);
    if (!pr) return;
    if (pr.state === "merged") throw new Error(`${ticket}: the PR is merged and cannot be closed`);
    await this.#gh("pr", "close", String(pr.number), "--repo", this.#repo);
  }

  async merge(ticket: string, opts: { matchHeadSha: string }): Promise<string> {
    const pr = await this.#find((await this.#locate(ticket)).branch);
    if (pr?.state !== "open") throw new Error(`${ticket}: no open PR to merge`);
    if (pr.headSha !== opts.matchHeadSha) throw new HeadMovedError(`head is ${pr.headSha}, not ${opts.matchHeadSha}`);
    try {
      await this.#gh("pr", "merge", String(pr.number), "--repo", this.#repo, "--squash", "--match-head-commit", opts.matchHeadSha);
    } catch (e) {
      // The pin is what makes this safe: GitHub refuses when the head moved after the read above.
      if (/head branch was modified|match-head-commit|expected head sha/i.test(errorText(e))) throw new HeadMovedError(`head moved from ${opts.matchHeadSha} while merging`);
      const now = await readPrState(this.#exec, pr.number, { repo: this.#repo });
      if (now.headSha !== opts.matchHeadSha) throw new HeadMovedError(`head is ${now.headSha}, not ${opts.matchHeadSha}`);
      throw e;
    }
    // The merge is done; GitHub can take a moment to show its commit, so wait for it rather than call a good merge a failure.
    for (let attempt = 1; ; attempt++) {
      const merged = await readPrState(this.#exec, pr.number, { repo: this.#repo });
      if (merged.mergeCommit) return merged.mergeCommit;
      if (attempt === MERGE_COMMIT_ATTEMPTS) throw new GhShapeError(`pr view ${pr.number}`, "the merged PR has no merge commit");
      await new Promise((r) => setTimeout(r, this.#retryMs));
    }
  }

  async openPrs(): Promise<OpenPr[]> {
    const call = "pr list";
    const out = await this.#gh("pr", "list", "--repo", this.#repo, "--state", "open", "--limit", "200", "--json", "number,url,headRefOid,files");
    return arr(call, json(call, out), "the response").map((r) => openPrRow(call, r));
  }

  async readFile(pr: OpenPr, path: string): Promise<string | undefined> {
    const call = `contents/${path}`;
    let out: string;
    try {
      out = await this.#api(`contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${pr.headSha}`);
    } catch (e) {
      if (/HTTP 404|Not Found/i.test(errorText(e))) return undefined;
      throw e;
    }
    const o = obj(call, json(call, out), "the response");
    if (str(call, o, "type") !== "file") return undefined;
    if (str(call, o, "encoding") !== "base64") throw new GhShapeError(call, `unsupported encoding ${String(o["encoding"])}`);
    return Buffer.from(str(call, o, "content"), "base64").toString("utf8");
  }

  async postStatus(sha: string, status: CommitStatus): Promise<void> {
    const description = status.description.length > DESCRIPTION_CAP ? `${status.description.slice(0, DESCRIPTION_CAP - 1)}…` : status.description;
    await this.#api(`statuses/${sha}`, "-X", "POST", "-f", `state=${status.state}`, "-f", `context=${status.context}`, "-f", `description=${description}`, ...(status.targetUrl ? ["-f", `target_url=${status.targetUrl}`] : []));
  }
}
