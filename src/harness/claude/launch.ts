import { join } from "node:path";
import type { ClaudeSubscriptionProfile } from "./profile.ts";
import type { SpawnSpec } from "./spawn.ts";

/** Host variables a worker may inherit. Everything else is dropped, so no stray API key or effort variable gets through. */
const HOST_ENV = ["ABT_HOME", "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "SSH_AUTH_SOCK"];

/** What a `dontAsk` worker may do. Anything not listed is denied. */
export const WORKER_ALLOW = [
  "Read", "Edit", "Write", "Glob", "Grep",
  // Procedures are hidden skills, so a worker starts on one through the Skill tool, never a slash command.
  "Skill(abt:*)",
  "Bash(npm *)", "Bash(node *)", "Bash(npx *)",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)", "Bash(git commit*)",
  "Bash(ls *)", "Bash(cat *)",
  // Read-only gh. Merging, creating and anything else is not listed.
  "Bash(gh pr view*)", "Bash(gh pr list*)", "Bash(gh pr diff*)", "Bash(gh pr checks*)", "Bash(gh pr status*)",
  "Bash(gh issue view*)", "Bash(gh issue list*)", "Bash(gh run view*)", "Bash(gh run list*)", "Bash(gh repo view*)",
  // The worker's own decision-log records.
  "Bash(abt log *)", "Bash(*/bin/abt log *)",
];

/** What a worker may never do. The PreToolUse guard logs these; the rules are the backstop if the guard does not run. */
export const WORKER_DENY = [
  "Bash(git push*)", "Bash(gh pr merge*)", "Bash(git switch*)", "Bash(git merge*)",
  // Only the owner, at a terminal, re-pins the protected files.
  "Bash(abt onboard pin*)", "Bash(*/bin/abt onboard pin*)",
];

/** The hooks a worker runs under: the feedback loop at Stop and the permission guard before each write-capable tool. */
export function workerHooks(profile: ClaudeSubscriptionProfile): Record<string, unknown> {
  const abt = join(profile.pluginDir, "bin", "abt");
  return {
    Stop: [{ hooks: [{ type: "command", command: `${abt} hook stop`, timeout: 600 }] }],
    PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `${abt} hook pre-tool-use` }] }],
  };
}

interface Common {
  profile: ClaudeSubscriptionProfile;
  /** The OAuth token, read from the Keychain at the moment of launch. Goes into the child's environment only. */
  token: string;
  hostEnv: Record<string, string | undefined>;
  settingsPath: string;
  sessionId: string;
  cwd: string;
  prompt: string;
}

export interface WorkerLaunch extends Common {
  kind: "worker";
  /** The abt procedure to start the worker on, by name. Omit for a raw prompt, as the startup self-test does. */
  procedure?: string;
  model: string;
  effort: string;
  feedback?: string[];
  /** Who the worker is, for the hooks and `abt log`. Set by the adapter; absent for the startup self-test. */
  ticket?: string;
  node?: string;
  run?: string;
  defaultBranch?: string;
  /** Extra environment for the worker (its isolated ports, database and build output). abt's own variables win. */
  workerEnv?: Record<string, string>;
  /** File counting the Stop hook's continues in this session. */
  stateFile?: string;
  /** Poll a worker that was still running: resume its session instead of starting one. */
  resume?: string;
}

export interface JudgeLaunch extends Common {
  kind: "judge";
  schema: object;
}

const PINNED = /^claude-[a-z0-9][a-z0-9.-]*$/;

/** The per-run settings file: auto-memory off and the worker allowlist. Never holds a credential. */
export function injectedSettings(extra: Record<string, unknown> = {}, feedback: string[] = []): string {
  const allow = [...WORKER_ALLOW, ...feedback.map((c) => `Bash(${c})`)];
  return JSON.stringify({ autoMemoryEnabled: false, permissions: { allow, deny: WORKER_DENY }, ...extra }, null, 2);
}

/** The host variables a Claude Code child may inherit. ANTHROPIC_API_KEY and any effort variable are never among them. */
export function allowedHostEnv(hostEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of HOST_ENV) {
    const v = hostEnv[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * What a worker is told before its task. A procedure is hidden from the command menu, so the worker invokes it by
 * name through the Skill tool. Whether it may ask a human is the worker's context, never the procedure's: none is
 * present, so where the procedure would ask, the worker raises an ask-point and the risk tier decides.
 */
function workerBrief(procedure: string, pluginDir: string, ticket?: string): string {
  const append = ticket ? `abt log append ${ticket}` : "abt log append <ticket>";
  return [
    `Start by invoking the abt procedure with the Skill tool: skill "abt:${procedure}". Follow it for this task.`,
    `No human is present. Where the procedure says to ask, interview or confirm with the human, do not wait: raise an ask-point. Write one record with \`${append}\` (JSON on stdin: kind "ask-point", decision = the question, why, evidence, result "open", payload {question, recommended, reversible}, plus raisesTo "high" when taking your recommendation would make this a high-risk change), then hand back. You never set how it is handled: the runner applies the risk tier, deciding with your recommended answer or escalating to the human.`,
    `Principles: the index is in your system prompt; read a principle's file under ${join(pluginDir, "principles")}/ only when its trigger fires. Reference files (codebase-design, writing-for-agents, experience-first) are under ${join(pluginDir, "reference")}/.`,
  ].join("\n\n");
}

/** Build the command line and environment for one headless Claude Code run. Pure. */
export function buildLaunch(l: WorkerLaunch | JudgeLaunch): SpawnSpec {
  const { profile } = l;
  const model = l.kind === "worker" ? l.model : profile.models.haiku;
  if (!PINNED.test(model)) throw new Error(`model must be a pinned model ID, not the alias "${model}"`);

  const feedback = (l.kind === "worker" && l.feedback) || [];
  const audit =
    l.kind === "worker" && l.ticket
      ? `Before you hand back, audit your own decision records: run \`abt log show ${l.ticket}\`, check that every ask-point and pivot record you wrote says what you actually did, and write a corrected record that supersedes any that is wrong. If the ticket turns out to depend on another ticket that has not merged, append a blocked record (payload {"by": ["<ticket id>"]}) and stop: the runner frees your slot and resumes the ticket once it merges. You may write only ask-point, pivot and blocked records. If the ticket looks like the wrong work type, write an ask-point: only the owner retypes a ticket, and a retype record of yours is refused.`
      : undefined;
  const prompt =
    l.kind === "worker" && l.procedure
      ? [
          workerBrief(l.procedure, profile.pluginDir, l.ticket),
          l.prompt,
          ...(feedback.length ? ["Run these until they pass:", ...feedback.map((c) => `- ${c}`)] : []),
          ...(audit ? [audit] : []),
        ].join("\n\n")
      : l.prompt;

  const args = [
    "-p", prompt,
    "--model", model,
    ...(l.kind === "worker" ? ["--effort", l.effort] : []),
    "--setting-sources", "project,local",
    "--settings", l.settingsPath,
    ...(l.kind === "worker" ? ["--plugin-dir", profile.pluginDir, "--append-system-prompt-file", join(profile.pluginDir, "principles", "index.md")] : ["--tools", "", "--json-schema", JSON.stringify(l.schema)]),
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--output-format", "stream-json",
    "--verbose",
    "--include-hook-events",
    ...(l.kind === "worker" && l.resume ? ["--resume", l.resume] : ["--session-id", l.sessionId]),
  ];

  const env = allowedHostEnv(l.hostEnv);
  if (l.kind === "worker" && l.workerEnv) Object.assign(env, l.workerEnv);
  if (l.kind === "worker" && l.ticket) {
    env.ABT_ROLE = "worker";
    env.ABT_TICKET = l.ticket;
    env.ABT_NODE = l.node ?? "";
    env.ABT_RUN = l.run ?? "";
    env.ABT_DEFAULT_BRANCH = l.defaultBranch ?? "main";
    env.ABT_FEEDBACK = JSON.stringify(feedback);
    if (l.stateFile) env.ABT_HOOK_STATE = l.stateFile;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = l.token;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_RETRY_WATCHDOG = "1";
  env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = String(profile.retryWatchdog.maxWaitMs);
  env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS = String(profile.retryWatchdog.maxUsageLimitWaitMs);
  return { command: profile.binary, args, cwd: l.cwd, env };
}
