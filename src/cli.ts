import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { systemClock } from "./clock.ts";
import { loadFakeWorld } from "./fake-world.ts";
import { runPass } from "./pass.ts";
import { TreeError } from "./tree.ts";
import { renderRun } from "./log/show.ts";
import { abtHome, DecisionLog, LogError } from "./log/store.ts";
import { WORKER_KINDS, type RecordInput } from "./log/record.ts";
import { DirTrees, LayeredTrees } from "./trees.ts";
import { hookCommand } from "./harness/claude/hooks.ts";
import { runnerCommand } from "./runner/cli.ts";
import { validateWithUses } from "./validate.ts";
import { policyProblems } from "./landing/policy.ts";
import { primaryCommand } from "./primary/cli.ts";
import { onboardCommand } from "./onboard/cli.ts";
import { watchCommand } from "./watch/app.ts";
import { upgradeCommand } from "./install/cli.ts";
import { selfTestCommand } from "./install/selftest.ts";
import { retypeAskPoint } from "./retype.ts";
import { WORK_TYPES } from "./tracker/contract.ts";

const USAGE = `usage: abt <command>

commands:
  run        run one pass of a behavior tree on a ticket
  log        append to or show a ticket's decision log
  runner     start, stop or inspect the runner daemon
  enqueue    hand one or more tickets to abt as a work type
  create     make a ticket from free text and enqueue it
  block      make one ticket block another
  reply      write a chat reply to an escalation on the ticket
  onboard    agree a merge policy for a repo: probe, open the PR, settle, pin
  validate   validate a behavior-tree or merge-policy YAML file
  watch      read-only live board of what the workers are doing
  upgrade    install a tag under the abt folder and switch to it, or roll back
  selftest   run the startup self-test of this install against Claude Code
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "validate") {
    const file = rest[0];
    if (!file) {
      console.error("usage: abt validate <file>");
      return 2;
    }
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`abt: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? e}`);
      return 2;
    }
    // A merge policy is validated against its own schema.
    if (/^merge-policy\.ya?ml$/.test(basename(file))) {
      const problems = policyProblems(source);
      for (const p of problems) console.error(`${file}: ${p}`);
      return problems.length === 0 ? 0 : 1;
    }
    // `use:` names resolve next to the file first, then in the plugin's default trees.
    const trees = new LayeredTrees(new DirTrees(dirname(file)), new DirTrees(fileURLToPath(new URL("../defaults/trees/", import.meta.url))));
    const diagnostics = await validateWithUses(source, file, trees);
    for (const d of diagnostics) console.error(d.message);
    return diagnostics.length === 0 ? 0 : 1;
  }

  if (command === "run") return runCommand(rest);

  if (command === "log") return logCommand(rest);

  if (command === "hook") return hookCommand(rest[0], readFileSync(0, "utf8"), process.env, (s) => console.log(s));

  if (command === "runner") return runnerCommand(rest);

  if (command === "enqueue" || command === "reply" || command === "create" || command === "block") return primaryCommand(command, rest);

  if (command === "onboard") return onboardCommand(rest);

  if (command === "watch") return watchCommand(rest);

  if (command === "upgrade") return upgradeCommand(rest);

  if (command === "selftest") return selfTestCommand();

  console.error(USAGE.trimEnd());
  return 2;
}

/**
 * A worker (ABT_ROLE=worker) may write only its own ticket's ask-point, pivot and blocked records.
 * An ask-point it raises is open and carries no `handling`: only the runner settles one, so the PR's
 * "decided" section can't be fed by a worker. It may send `raisesTo`, the tier its recommendation would
 * reach: that can only make the runner escalate, never skip an escalation.
 */
function workerLogViolation(env: NodeJS.ProcessEnv, ticket: string, input: RecordInput): string | undefined {
  if (env.ABT_ROLE !== "worker") return undefined;
  if (!WORKER_KINDS.some((k) => k === input?.kind)) {
    return `workers may only write ask-point, pivot and blocked records, not ${JSON.stringify(input?.kind)}`;
  }
  if (env.ABT_TICKET && env.ABT_TICKET !== ticket) return `workers may only write to their own ticket's log (${env.ABT_TICKET}), not ${ticket}`;
  if (input.kind === "ask-point") {
    if (input.payload && "handling" in input.payload) return "workers may not set handling on an ask-point: only the runner settles ask-points";
    if (input.result !== "open") return `a worker's ask-point must have result "open", not ${JSON.stringify(input.result)}: only the runner settles ask-points`;
  }
  return undefined;
}

function logCommand(args: string[]): number {
  const [sub, ticket, ...flags] = args;
  const log = new DecisionLog(abtHome(), systemClock, randomUUID);
  try {
    if (sub === "append" && ticket) {
      const input = JSON.parse(readFileSync(0, "utf8")) as RecordInput;
      const denied = workerLogViolation(process.env, ticket, input);
      if (denied && input.kind === "retype" && process.env.ABT_ROLE === "worker" && (!process.env.ABT_TICKET || process.env.ABT_TICKET === ticket)) {
        // Only the human retypes a ticket: the worker's attempt becomes an ask-point that always escalates.
        const to = input.payload?.to;
        const from = input.payload?.from;
        if (to && WORK_TYPES.includes(to)) {
          const a = retypeAskPoint(ticket, from && WORK_TYPES.includes(from) ? from : undefined, to);
          log.append(ticket, {
            run: input.run, node: input.node ?? null, kind: "ask-point", decision: `${a.handling}: ${a.question}`,
            why: "only the owner can retype a ticket; a worker that sees a type mismatch asks instead", evidence: null, result: "open",
            payload: { question: a.question, recommended: a.recommended, reversible: a.reversible, handling: a.handling, retype: a.retype },
          });
          console.error("abt: only the owner can retype a ticket; your retype was refused and raised as an ask-point instead");
          return 1;
        }
      }
      if (denied) {
        console.error(`abt: ${denied}`);
        return 1;
      }
      console.log(log.append(ticket, input).id);
      return 0;
    }
    if (sub === "show" && ticket) {
      const i = flags.indexOf("--run");
      const run = i >= 0 ? flags[i + 1] : undefined;
      const records = log.read(ticket);
      if (records.length === 0) {
        console.error(`abt: no decision log for ${ticket}`);
        return 1;
      }
      console.log(renderRun(records, run));
      return 0;
    }
  } catch (e) {
    if (e instanceof LogError || e instanceof SyntaxError) {
      console.error(`abt: ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.error("usage: abt log append <ticket>  (record JSON on stdin)\n       abt log show <ticket> [--run <id>]");
  return 2;
}

async function runCommand(args: string[]): Promise<number> {
  const [treeFile, ticket, ...flags] = args;
  const w = flags.indexOf("--world");
  const worldFile = w >= 0 ? flags[w + 1] : undefined;
  if (!treeFile || !ticket) {
    console.error("usage: abt run <tree.yaml> <ticket> --world <world.json>");
    return 2;
  }
  if (!worldFile) {
    console.error("abt: only a fake world is wired so far; pass --world <world.json>");
    return 2;
  }
  try {
    const tree = readFileSync(treeFile, "utf8");
    const world = await loadFakeWorld(worldFile);
    await world.tracker.readTicket(ticket);
    const newId = randomUUID;
    const log = new DecisionLog(abtHome(), world.clock, newId);
    const { run, result } = await runPass({ tree, ticket, tracker: world.tracker, codeHost: world.codeHost, harness: world.harness, workspace: world.workspace, log, newId, trees: new LayeredTrees(new DirTrees(dirname(treeFile)), new DirTrees(fileURLToPath(new URL("../defaults/trees/", import.meta.url)))) });
    console.log(renderRun(log.read(ticket), run));
    console.log(`pass ${run}: ${result}`);
    return result === "ok" || result === "running" || result === "open" ? 0 : 1;
  } catch (e) {
    if (e instanceof TreeError || e instanceof LogError || (e as NodeJS.ErrnoException).code === "ENOENT" || /no such ticket/.test((e as Error).message)) {
      console.error(`abt: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

process.exitCode = await main(process.argv.slice(2));
