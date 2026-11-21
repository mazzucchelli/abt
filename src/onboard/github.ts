import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { projectIdFromRemote, type FactsProbe, type ProjectFacts } from "./facts.ts";
import type { DefaultBranchFiles, OnboardHost, OnboardPr, OpenedPr, PrState } from "./host.ts";

const run = promisify(execFile);

const errorText = (e: unknown) => `${(e as Error).message} ${(e as { stderr?: string }).stderr ?? ""}`;

/** Runs a command and resolves to its stdout. Injected so the adapters are testable without git or gh. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

export const systemExec: Exec = async (cmd, args, opts) => (await run(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The default branch as the remote has it. */
export async function remoteDefaultBranch(repo: string, exec: Exec = systemExec): Promise<string> {
  try {
    return (await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo })).trim().replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

/** The facts, read with `git` and `gh`. A read that fails leaves its fact unknown: onboarding never guesses. */
export class GhProbe implements FactsProbe {
  readonly #repo: string;
  readonly #exec: Exec;
  readonly #noApps: boolean;
  #files: Promise<string[]> | undefined;
  #meta: Promise<{ branch: string; slug: string; id: string; private?: boolean; visibility?: string; autoMerge?: boolean; ownerType?: string }> | undefined;

  constructor(o: { repo: string; exec?: Exec; /** The human said no installed GitHub App can write here: a user token can't read that. */ confirmedNoWriteApps?: boolean }) {
    this.#repo = o.repo;
    this.#exec = o.exec ?? systemExec;
    this.#noApps = o.confirmedNoWriteApps ?? false;
  }

  async #try<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }

  #api<T>(slug: string, path: string): Promise<T> {
    return this.#exec("gh", ["api", `repos/${slug}${path}`], { cwd: this.#repo }).then((s) => JSON.parse(s) as T);
  }

  #info() {
    return (this.#meta ??= (async () => {
      const remote = (await this.#exec("git", ["remote", "get-url", "origin"], { cwd: this.#repo })).trim();
      const id = projectIdFromRemote(remote);
      if (!id) throw new Error(`origin is not a GitHub remote: ${remote}`);
      const slug = id.replace("__", "/");
      const repo = await this.#try(() => this.#api<{ default_branch: string; private?: boolean; visibility?: string; allow_auto_merge?: boolean; owner?: { type?: string } }>(slug, ""));
      return {
        id, slug, branch: repo?.default_branch ?? (await remoteDefaultBranch(this.#repo, this.#exec)),
        ...(repo?.private !== undefined && { private: repo.private }),
        ...(repo?.visibility !== undefined && { visibility: repo.visibility }),
        ...(repo?.allow_auto_merge !== undefined && { autoMerge: repo.allow_auto_merge }),
        ...(repo?.owner?.type !== undefined && { ownerType: repo.owner.type }),
      };
    })());
  }

  files(): Promise<string[]> {
    return (this.#files ??= (async () => {
      const { branch } = await this.#info();
      return (await this.#exec("git", ["ls-tree", "-r", "--name-only", `origin/${branch}`], { cwd: this.#repo })).split("\n").filter(Boolean);
    })());
  }

  async #show(path: string): Promise<string | undefined> {
    const { branch } = await this.#info();
    return this.#try(() => this.#exec("git", ["show", `origin/${branch}:${path}`], { cwd: this.#repo }));
  }

  async #protection(slug: string, branch: string): Promise<ProjectFacts["protection"]> {
    let rulesets: { enforcement?: string }[];
    try {
      rulesets = await this.#api(slug, "/rulesets");
    } catch (e) {
      // A plan with no rulesets is an answer; any other failure is not.
      if (!/Upgrade to GitHub Pro/.test(errorText(e))) return undefined;
      rulesets = [];
    }
    let prot: { required_status_checks?: { contexts?: string[] }; required_pull_request_reviews?: { required_approving_review_count?: number } } | undefined;
    try {
      prot = await this.#api(slug, `/branches/${branch}/protection`);
    } catch (e) {
      // "Not protected" is an answer. A bare 404 is not: GitHub sends it to tokens without admin rights too.
      if (!/Branch not protected|Upgrade to GitHub Pro/.test(errorText(e))) return undefined;
    }
    const active = rulesets.some((r) => r.enforcement === "active");
    if (!prot && !active) return { enforced: false, required_checks: [], approvals: 0 };
    return { enforced: true, required_checks: prot?.required_status_checks?.contexts ?? [], approvals: prot?.required_pull_request_reviews?.required_approving_review_count ?? 0 };
  }

  async #ci(): Promise<ProjectFacts["ci"]> {
    const workflows = (await this.files()).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
    if (workflows.length === 0) return { jobs: [] };
    const names: string[] = [];
    const aggregators: string[] = [];
    for (const file of workflows) {
      const source = await this.#show(file);
      if (source === undefined) return undefined;
      const doc = parse(source) as { jobs?: Record<string, { name?: string; needs?: string | string[] }> } | null;
      const jobs = Object.entries(doc?.jobs ?? {}).map(([key, job]) => ({ key, name: job.name ?? key, needs: ([] as string[]).concat(job.needs ?? []) }));
      names.push(...jobs.map((j) => j.name));
      // The aggregator is the job that waits on every other job in its own workflow, so a single check stands for them all.
      const own = jobs.find((j) => j.needs.length > 0 && jobs.every((o) => o === j || j.needs.includes(o.key)));
      if (own) aggregators.push(own.name);
    }
    // Two aggregators is ambiguous: the human picks, so none is named.
    return { jobs: names, ...(aggregators.length === 1 && { aggregator: aggregators[0]! }) };
  }

  async #tests(): Promise<string[]> {
    const files = await this.files();
    const out: string[] = [];
    const pkg = files.includes("package.json") ? await this.#show("package.json") : undefined;
    if (pkg && typeof (JSON.parse(pkg) as { scripts?: { test?: string } }).scripts?.test === "string") out.push((JSON.parse(pkg) as { scripts: { test: string } }).scripts.test);
    if (files.includes("go.mod")) out.push("go test");
    if (files.includes("Cargo.toml")) out.push("cargo test");
    if (files.some((p) => ["pytest.ini", "pyproject.toml", "tox.ini"].includes(p))) out.push("pytest");
    return out;
  }

  async facts(): Promise<ProjectFacts> {
    const info = await this.#info();
    const { slug, branch } = info;
    const collaborators = await this.#try(() => this.#api<{ login: string; permissions?: { push?: boolean; admin?: boolean } }[]>(slug, "/collaborators?permission=push"));
    const keys = await this.#try(() => this.#api<{ title: string; read_only: boolean }[]>(slug, "/keys"));
    const protection = await this.#protection(slug, branch);
    const ci = await this.#try(() => this.#ci());
    const files = await this.#try(() => this.files());
    const visibility = info.visibility ?? (info.private === undefined ? undefined : info.private ? "private" : "public");
    const facts: ProjectFacts = { id: info.id, default_branch: branch };
    const set = <K extends keyof ProjectFacts>(k: K, v: ProjectFacts[K] | undefined) => {
      if (v !== undefined) facts[k] = v as ProjectFacts[K];
    };
    set("visibility", visibility as ProjectFacts["visibility"]);
    set("protection", protection);
    set("allow_auto_merge", info.autoMerge);
    // A merge queue is an organization feature; for an organization repo it depends on the plan, which a token can't read.
    set("merge_queue_available", info.ownerType === "User" ? false : undefined);
    set("write_collaborators", collaborators?.filter((c) => c.permissions?.push || c.permissions?.admin).map((c) => c.login));
    set("write_apps", keys === undefined || !this.#noApps ? undefined : keys.filter((k) => !k.read_only).map((k) => k.title));
    set("ci", ci);
    set("test_tooling", files === undefined ? undefined : await this.#try(() => this.#tests()));
    set("preview_deployments", files?.some((p) => /^(vercel\.json|netlify\.toml|\.vercel\/|render\.yaml)/.test(p)));
    return facts;
  }
}

/** Opens the onboarding PR with `git` and `gh`. The PR is never merged from here. */
export class GhHost implements OnboardHost {
  readonly #repo: string;
  readonly #base: string;
  readonly #exec: Exec;
  readonly #scratch: string | undefined;

  constructor(o: { repo: string; defaultBranch: string; exec?: Exec; /** An empty directory to build the branch in; by default a fresh temporary one. */ scratchDir?: string }) {
    this.#repo = o.repo;
    this.#base = o.defaultBranch;
    this.#exec = o.exec ?? systemExec;
    this.#scratch = o.scratchDir;
  }

  async openPr(pr: OnboardPr): Promise<OpenedPr> {
    const dir = this.#scratch ?? join(await mkdtemp(join(tmpdir(), "abt-onboard-")), "wt");
    const git = (...args: string[]) => this.#exec("git", args, { cwd: dir });
    try {
      await this.#exec("git", ["worktree", "add", "-B", pr.branch, dir, `origin/${this.#base}`], { cwd: this.#repo });
      for (const [path, content] of Object.entries(pr.files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
      }
      await git("add", "--all");
      await git("commit", "-m", pr.title);
      await git("push", "--set-upstream", "origin", pr.branch);
      const url = (await this.#exec("gh", ["pr", "create", "--base", this.#base, "--head", pr.branch, "--title", pr.title, "--body", pr.body], { cwd: this.#repo })).trim();
      const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
      if (!Number.isInteger(number)) throw new Error(`gh did not return a PR URL: ${url}`);
      return { number, url };
    } finally {
      await this.#exec("git", ["worktree", "remove", "--force", dir], { cwd: this.#repo }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  async readState(number: number): Promise<PrState> {
    const out = JSON.parse(await this.#exec("gh", ["pr", "view", String(number), "--json", "state,mergeCommit"], { cwd: this.#repo })) as { state: string; mergeCommit?: { oid?: string } | null };
    if (out.state === "MERGED") return { state: "merged", mergeCommit: out.mergeCommit?.oid ?? "" };
    return { state: out.state === "CLOSED" ? "closed" : "open" };
  }
}

/** Files as committed on `origin/<default branch>`, never the working tree. */
export class GitFiles implements DefaultBranchFiles {
  readonly #repo: string;
  readonly #ref: string;
  readonly #exec: Exec;
  constructor(repo: string, defaultBranch: string, exec: Exec = systemExec, ref = `origin/${defaultBranch}`) {
    this.#repo = repo;
    this.#ref = ref;
    this.#exec = exec;
  }
  at(commit: string): DefaultBranchFiles {
    return new GitFiles(this.#repo, "", this.#exec, commit);
  }
  async list(prefix: string): Promise<string[]> {
    return (await this.#exec("git", ["ls-tree", "-r", "--name-only", this.#ref, "--", prefix], { cwd: this.#repo })).split("\n").filter(Boolean);
  }
  async read(path: string): Promise<string | undefined> {
    if ((await this.list(path)).length === 0) return undefined;
    return this.#exec("git", ["show", `${this.#ref}:${path}`], { cwd: this.#repo });
  }
}
