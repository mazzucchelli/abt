import { join } from "node:path";
import { createLinearTracker } from "../tracker/linear.ts";
import { resolveCredential } from "../tracker/credentials.ts";
import { ADAPTER_DOC_PATH, loadAdapterDoc, type TrackerConfig } from "../tracker/config.ts";
import type { Tracker } from "../tracker/contract.ts";
import type { CodeHost, PrHost } from "../codehost/contract.ts";
import { GhCodeHost } from "../codehost/gh.ts";
import { systemExec, type Exec } from "../codehost/exec.ts";
import { FileGuard, LandingGuard } from "../landing/guard.ts";
import type { HarnessAdapter } from "../harness/contract.ts";
import { ClaudeCodeAdapter } from "../harness/claude/adapter.ts";
import { claudeGradeClassifier } from "../harness/claude/grade-judge.ts";
import { claudeRiskClassifier } from "../harness/claude/risk-judge.ts";
import { claudeVerdictJudge } from "../harness/claude/verdict-judge.ts";
import type { JudgeDeps } from "../harness/claude/judge.ts";
import { CLAUDE_SUBSCRIPTION, type ClaudeSubscriptionProfile } from "../harness/claude/profile.ts";
import type { Spawner } from "../harness/claude/spawn.ts";
import type { Judge } from "../judge/contract.ts";
import type { DecisionLog } from "../log/store.ts";
import { projectIdFromRemote, repoSlug } from "../onboard/facts.ts";
import { GhHost, GhProbe, GitFiles, remoteDefaultBranch } from "../onboard/github.ts";
import type { DefaultBranchFiles } from "../onboard/host.ts";
import { FilePins, settleOnboarding, type PinStore } from "../onboard/pins.ts";
import { PrValidator } from "../pr-validation.ts";
import { branchFor } from "../workspace/branch.ts";
import type { GradeClassifier, RoutingDeps } from "../routing.ts";
import type { RiskClassifier } from "../risk/assess.ts";
import type { TicketRunDeps } from "../ticket-run.ts";
import { GitTrees, type TreeStore } from "../trees.ts";
import type { Workspace } from "../workspace/contract.ts";
import { WorkerEnvs, type IsolationConfig } from "../workspace/env.ts";
import { GitWorkspace } from "../workspace/git.ts";
import { GitPolicy, type PolicyStore } from "../landing/policy.ts";
import type { ProjectEntry } from "./config.ts";
import type { RunnerProject } from "./daemon.ts";

/** Everything one project's world supplies, whether it is real or fake. The judges are optional because the fake world has none. */
export interface ProjectPorts {
  name: string;
  tracker: Tracker;
  codeHost: CodeHost & PrHost;
  harness: HarnessAdapter;
  workspace: Workspace;
  envs: WorkerEnvs;
  defaultBranch: string;
  /** The project's own trees, from its default branch. */
  trees: TreeStore;
  /** Answers `judge:` nodes. */
  judge?: Judge;
  routing?: RoutingDeps;
  risk?: TicketRunDeps["risk"];
  /** Where the agreed risk map is read from. Not the landing policy: the map alone feeds the floors. */
  riskPolicy?: PolicyStore;
  maxWorkers?: number;
  /** Re-probes the project before every autonomous merge and watches the default branch after it. */
  guard?: LandingGuard;
  /** The name of the launch profile the project's workers run under; a usage limit pauses dispatch per profile. */
  profileName?: string;
  /**
   * The project's pins and the default-branch files they cover. A project served without them can never merge: a
   * `mode: merge` policy with no pin store fails closed.
   */
  pins?: { files: DefaultBranchFiles; store: PinStore; project: string };
  /** Pins the project's abt files once its onboarding PR is merged by hand. */
  onboarding?: { settle(): Promise<unknown> };
}

/** What every project shares. */
export interface SharedDeps {
  log: DecisionLog;
  newId: () => string;
  /** The default trees shipped with the plugin. */
  plugin: TreeStore;
}

/**
 * The one place a project's `RunnerProject` is put together, so the real runner and `--world` cannot
 * drift: they differ only in the ports they pass.
 */
export function assembleProject(p: ProjectPorts, shared: SharedDeps): RunnerProject {
  const { tracker, codeHost, harness, workspace, envs, judge, routing, risk, riskPolicy, guard, pins, onboarding } = p;
  const { log, newId, plugin } = shared;
  return {
    name: p.name, tracker, log, workspace, envs, defaultBranch: p.defaultBranch,
    prValidator: new PrValidator({ host: codeHost, plugin, onError: (e, where) => console.error(`abt runner: ${where}: ${(e as Error).message}`) }),
    ...(p.maxWorkers && { maxWorkers: p.maxWorkers }),
    ...(p.profileName && { profile: p.profileName }),
    ...(guard && { guard }),
    ...(onboarding && { onboarding }),
    deps: (ticket) => ({
      ticket, tracker, codeHost, harness, workspace, envs, log, newId, plugin, project: p.trees,
      ...(judge && { judge }), ...(routing && { routing }), ...(risk && { risk }), ...(riskPolicy && { riskPolicy }), ...(guard && { guard }), ...(pins && { pins }),
    }),
  };
}

/** What the real world needs from the machine; each seam can be swapped in a test. */
export interface RealContext extends SharedDeps {
  /** The abt home: worktrees and lanes live under it. */
  home: string;
  profile: ClaudeSubscriptionProfile;
  hostEnv: Record<string, string | undefined>;
  /** Spawns every Claude run: workers and judges. */
  spawn: Spawner;
  /** The dispatch gate (the startup self-test). */
  ready: () => Promise<void>;
  /** Reads the OAuth token at the moment of each launch. Never cached. */
  readToken: () => string;
  createTracker?: (config: TrackerConfig) => Promise<Tracker>;
  /** Runs `git` and `gh` for every project. Defaults to the machine's own. */
  exec?: Exec;
}

const REFRESH_MS = 5_000;

/** Files as the default branch has them now: `refresh` (a fetch) runs before a read, and a fetch that fails leaves the last known state. */
function refreshed(files: DefaultBranchFiles, refresh: () => Promise<unknown>, fetching: { at: number } = { at: 0 }): DefaultBranchFiles {
  // One check reads every protected file: a fetch within the last few seconds is fresh enough for the next read.
  const fresh = async () => {
    if (Date.now() - fetching.at < REFRESH_MS) return;
    fetching.at = Date.now();
    await refresh().catch(() => undefined);
  };
  return {
    async list(prefix) {
      await fresh();
      return files.list(prefix);
    },
    async read(path) {
      await fresh();
      return files.read(path);
    },
    // A commit is fetched before it is read, so a merge commit the daemon has not seen yet is there.
    ...(files.at && { at: (commit: string) => refreshed(files.at!(commit), refresh, { at: 0 }) }),
  };
}

/** One configured project's real ports: its adapter doc, git checkout, GitHub remote and the Claude harness. */
async function buildRealPorts(entry: ProjectEntry, ctx: RealContext): Promise<ProjectPorts> {
  const exec = ctx.exec ?? systemExec;
  const doc = loadAdapterDoc(join(entry.path, ADAPTER_DOC_PATH));
  const tracker = await (ctx.createTracker ?? ((c) => createLinearTracker(c, { apiKey: resolveCredential(c.credentials) })))(doc.tracker);

  const remote = (await exec("git", ["remote", "get-url", "origin"], { cwd: entry.path })).trim();
  const id = projectIdFromRemote(remote);
  if (!id) throw new Error(`origin is not a GitHub remote: ${remote}`);
  const defaultBranch = await remoteDefaultBranch(entry.path, exec);
  // Project trees and new worker branches are read from the remote default branch, so it must be known here.
  const tip = `origin/${defaultBranch}`;
  await exec("git", ["fetch", "origin"], { cwd: entry.path }).catch(() => undefined);
  await exec("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/${tip}`], { cwd: entry.path }).catch(() => {
    throw new Error(`${tip} is not known in ${entry.path}: fetch it once`);
  });
  const codeHost = new GhCodeHost({
    repo: repoSlug(id), defaultBranch, exec,
    // Revert PRs are made from the project's own checkout.
    checkout: entry.path,
    // The ticket's branch and PR title are the ones the worker was started on.
    locate: async (t) => {
      const ticket = await tracker.readTicket(t);
      return { branch: branchFor(ticket, ctx.log.read(t)), title: ticket.title };
    },
  });

  // The pins live in the abt home, outside the repo. Every read of the protected files starts from a fresh fetch, so a change that landed since the daemon started is seen.
  const pinStore = new FilePins(ctx.home);
  const files = refreshed(new GitFiles(entry.path, defaultBranch, exec), () => exec("git", ["fetch", "origin"], { cwd: entry.path }));
  const pins = { files, store: pinStore, project: id };
  const onboardHost = new GhHost({ repo: entry.path, defaultBranch, exec });

  // The default branch's side of a merge: the merge policy as committed there, the abt home's record of pauses and watched merges, the pins, and real CI and revert PRs.
  const guard = new LandingGuard({ project: id, probe: new GhProbe({ repo: entry.path, exec }), store: new FileGuard(ctx.home), policy: new GitPolicy(entry.path, tip), tracker, main: codeHost, pins: { files, store: pinStore } });

  const { profile } = ctx;
  // A judge reads the token per call, so a rotated Keychain item is picked up without a restart.
  const judgeDeps = (): JudgeDeps => ({ profile, spawn: ctx.spawn, token: ctx.readToken(), hostEnv: ctx.hostEnv, workDir: join(ctx.home, "judge", entry.name) });
  const judge: Judge = { ask: (req) => claudeVerdictJudge(judgeDeps()).ask(req) };
  const grade: GradeClassifier = { classify: (req) => claudeGradeClassifier(judgeDeps()).classify(req) };
  const risk: RiskClassifier = { classify: (req) => claudeRiskClassifier(judgeDeps()).classify(req) };

  const isolation: IsolationConfig | undefined = doc.isolation;
  return {
    name: entry.name,
    tracker,
    codeHost,
    harness: new ClaudeCodeAdapter({ profile, spawn: ctx.spawn, readToken: ctx.readToken, hostEnv: ctx.hostEnv, ready: ctx.ready, newId: ctx.newId }),
    workspace: new GitWorkspace(entry.path, join(ctx.home, "worktrees", entry.name), tip),
    envs: new WorkerEnvs(join(ctx.home, "lanes", entry.name), isolation),
    defaultBranch,
    guard,
    pins,
    onboarding: { settle: () => settleOnboarding({ host: onboardHost, files, pins: pinStore, project: id }) },
    trees: new GitTrees(entry.path, tip, ".agents/abt/trees"),
    judge,
    routing: { classifier: grade, models: { sonnet: profile.models.sonnet, opus: profile.models.opus } },
    risk: { classifier: risk },
    riskPolicy: new GitPolicy(entry.path, tip),
    ...(entry.maxWorkers && { maxWorkers: entry.maxWorkers }),
    profileName: CLAUDE_SUBSCRIPTION,
  };
}

/**
 * Builds every configured project. One that cannot be served (no adapter doc, no GitHub remote, a Linear
 * team that does not match) is skipped with its reason and the others still run: launchd would only
 * restart a daemon that exited.
 */
export async function serveProjects(entries: ProjectEntry[], ctx: RealContext): Promise<{ projects: RunnerProject[]; lines: string[] }> {
  const projects: RunnerProject[] = [];
  const lines: string[] = [];
  for (const entry of entries) {
    try {
      projects.push(assembleProject(await buildRealPorts(entry, ctx), ctx));
      lines.push(`abt runner: serving project "${entry.name}" (${entry.path})`);
    } catch (e) {
      lines.push(`abt runner: project "${entry.name}" skipped: ${(e as Error).message}`);
    }
  }
  return { projects, lines };
}
