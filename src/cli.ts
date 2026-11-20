import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { systemClock } from "./clock.ts";
import { loadFakeWorld } from "./fake-world.ts";
import { runPass } from "./pass.ts";
import { TreeError } from "./tree.ts";
import { renderRun } from "./log/show.ts";
import { abtHome, DecisionLog, LogError } from "./log/store.ts";
import type { RecordInput } from "./log/record.ts";
import { validate } from "./validate.ts";

const STUBS = ["onboard", "upgrade"];
const USAGE = `usage: abt <command>

commands:
  run        run one pass of a behavior tree on a ticket
  log        append to or show a ticket's decision log
  onboard    onboard a repo (not implemented)
  validate   validate a behavior-tree YAML file
  upgrade    upgrade abt (not implemented)
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
    const diagnostics = validate(source, file);
    for (const d of diagnostics) console.error(d.message);
    return diagnostics.length === 0 ? 0 : 1;
  }

  if (command === "run") return runCommand(rest);

  if (command === "log") return logCommand(rest);

  if (command && STUBS.includes(command)) {
    console.error(`abt ${command}: not implemented`);
    return 2;
  }

  console.error(USAGE.trimEnd());
  return 2;
}

function logCommand(args: string[]): number {
  const [sub, ticket, ...flags] = args;
  const log = new DecisionLog(abtHome(), systemClock, randomUUID);
  try {
    if (sub === "append" && ticket) {
      const input = JSON.parse(readFileSync(0, "utf8")) as RecordInput;
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
    const { run, result } = await runPass({ tree, ticket, tracker: world.tracker, codeHost: world.codeHost, harness: world.harness, log, newId });
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
