import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { systemClock } from "../../clock.ts";
import { abtHome, DecisionLog } from "../../log/store.ts";

/** How many times a red feedback check may send a worker back to work in one session. */
export const MAX_CONTINUES = 3;

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const GIT_READ_ONLY_BRANCH = ["--list", "-l", "-a", "-r", "-v", "-vv", "--show-current", "--all", "--remotes", "--contains", "--merged", "--no-merged"];

/** Why a tool call is refused to a worker, or undefined when it is allowed. Pure. */
export function guardToolCall(tool: string, input: { command?: string }, currentBranch: string | undefined, defaultBranch: string): string | undefined {
  const onDefault = currentBranch !== undefined && currentBranch === defaultBranch;
  if (WRITE_TOOLS.includes(tool)) return onDefault ? `writes to the default branch (${defaultBranch}) are not allowed` : undefined;
  if (tool !== "Bash") return undefined;
  for (const segment of String(input.command ?? "").split(/&&|\|\||[;|\n(){}`]|\$\(/)) {
    const why = guardSegment(segment.trim().split(/\s+/), onDefault, defaultBranch);
    if (why) return why;
  }
  return undefined;
}

function guardSegment(words: string[], onDefault: boolean, defaultBranch: string): string | undefined {
  // Skip leading VAR=value assignments.
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  const [bin, ...rest] = words.slice(i);
  if (bin === "gh") {
    const [area, verb] = rest.filter((w) => !w.startsWith("-"));
    if (area === "pr" && verb === "merge") return "merging a pull request is not allowed";
    return undefined;
  }
  if (bin !== "git") return undefined;
  // Skip git's global options (`-C <dir>`, `-c <k=v>`, `--git-dir=...`) to find the subcommand.
  let j = 0;
  while (j < rest.length && rest[j]!.startsWith("-")) j += rest[j] === "-C" || rest[j] === "-c" ? 2 : 1;
  const sub = rest[j];
  const args = rest.slice(j + 1);
  switch (sub) {
    case "push":
      return "pushing is not allowed";
    case "merge":
      return "merging is not allowed";
    case "switch":
      return "switching or creating a branch is not allowed";
    case "checkout":
      // `git checkout -- <path>` restores a file; everything else moves HEAD or creates a branch.
      return args[0] === "--" ? undefined : "switching or creating a branch is not allowed";
    case "branch":
      return args.every((a) => GIT_READ_ONLY_BRANCH.includes(a)) ? undefined : "creating or changing a branch is not allowed";
    case "commit":
    case "add":
      return onDefault ? `writes to the default branch (${defaultBranch}) are not allowed` : undefined;
    default:
      return undefined;
  }
}

export interface HookEnv {
  home: string;
  ticket: string;
  run: string;
  node: string;
  defaultBranch: string;
  feedback: string[];
  /** File holding the number of continues already spent in this session. */
  state: string | undefined;
}

export function hookEnv(env: NodeJS.ProcessEnv): HookEnv {
  let feedback: string[] = [];
  try {
    const parsed: unknown = JSON.parse(env.ABT_FEEDBACK ?? "[]");
    if (Array.isArray(parsed)) feedback = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    // unreadable feedback config: nothing to run
  }
  return {
    home: abtHome(env),
    ticket: env.ABT_TICKET ?? "",
    run: env.ABT_RUN ?? "",
    node: env.ABT_NODE ?? "",
    defaultBranch: env.ABT_DEFAULT_BRANCH ?? "main",
    feedback,
    state: env.ABT_HOOK_STATE,
  };
}

/** Records written by a hook go on a side node of the worker's own, so they never read as that node's outcome. */
function logGuard(e: HookEnv, decision: string, why: string): void {
  if (!e.ticket) return;
  new DecisionLog(e.home, systemClock, randomUUID).append(e.ticket, {
    run: e.run || "unknown", node: `${e.node}#guard`, kind: "node-outcome", decision, why, evidence: null, result: "fail", payload: { nodeKind: "agent" },
  });
}

function currentBranch(cwd: string): string | undefined {
  try {
    const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return b === "HEAD" ? undefined : b;
  } catch {
    return undefined;
  }
}

/** `abt hook <stop|pre-tool-use>`: reads the hook payload on stdin, prints the hook's JSON answer. Always exits 0. */
export function hookCommand(name: string | undefined, stdin: string, env: NodeJS.ProcessEnv, out: (s: string) => void): number {
  const e = hookEnv(env);
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(stdin) as Record<string, any>;
  } catch {
    // no payload
  }
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  if (name === "pre-tool-use") {
    const tool = String(payload.tool_name ?? "");
    const input = payload.tool_input ?? {};
    const why = guardToolCall(tool, input, currentBranch(cwd), e.defaultBranch);
    if (why) {
      const what = tool === "Bash" ? String(input.command ?? "") : `${tool} ${String(input.file_path ?? input.notebook_path ?? "")}`.trim();
      try {
        logGuard(e, `denied ${what}`, why);
      } catch {
        // The denial must hold even when the log cannot be written: a crashing hook would let the call through.
      }
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `abt: ${why}. Workers cannot land code; hand back instead.` } }));
    }
    return 0;
  }

  if (name === "stop") {
    const red = firstRed(e.feedback, cwd);
    if (!red) return 0;
    // Without a state file the budget cannot be counted; never loop forever.
    if (!e.state && payload.stop_hook_active === true) return 0;
    const used = e.state && existsSync(e.state) ? Number(readFileSync(e.state, "utf8")) || 0 : 0;
    if (used < MAX_CONTINUES) {
      if (e.state) writeFileSync(e.state, String(used + 1));
      out(JSON.stringify({ decision: "block", reason: `The feedback check is red (continue ${used + 1} of ${MAX_CONTINUES}). Fix it before you finish.\n\n$ ${red.command}\n${red.output}` }));
      return 0;
    }
    logGuard(e, "feedback check still red at hand-back", `feedback check red after ${MAX_CONTINUES} continues: ${red.command}\n${red.output}`.slice(0, 2000));
    return 0;
  }
  return 0;
}

/** Runs the feedback commands in order; the first failure, with its tail of output, or undefined when all pass. */
function firstRed(commands: string[], cwd: string): { command: string; output: string } | undefined {
  for (const command of commands) {
    const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return { command, output: `${r.stdout}${r.stderr}`.trim().split("\n").slice(-40).join("\n") };
  }
  return undefined;
}
