import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { abtHome } from "../log/store.ts";
import { GitPolicy } from "../landing/policy.ts";
import { sendNudge } from "../runner/socket.ts";
import { ADAPTER_DOC_PATH, loadAdapterDoc } from "../tracker/config.ts";
import { resolveCredential } from "../tracker/credentials.ts";
import { createLinearTracker } from "../tracker/linear.ts";
import { addBlockerEdge, enqueueBatch, enqueueOne } from "./batch.ts";
import { replyToEscalation } from "./enqueue.ts";
import { enqueueFreeText } from "./free-text.ts";

const USAGE = `usage: abt enqueue <ticket[:type]>... [intake flags] [--project <dir>]
       abt create [intake flags] [--] <text...> [--project <dir>]
       abt block <ticket> <blocker> [--project <dir>]
       abt reply <ticket> <text...> [--project <dir>]

enqueue   hand one or more tickets to abt: a nudge and a one-line ack, or for several a summary table
create    make a ticket from free text, then enqueue it (put -- before text that contains flags)
block     make <blocker> block <ticket>, after the user agreed to a blocker edge
reply     write a chat reply to an escalation on the ticket as the owner's comment

intake flags (the strongest one that is set wins: --type, a ticket's own label, --entry, --inferred):
  --type <work type>    the type the user named
  --entry <work type>   the type the entry point implies
  --inferred <type>     your own reading of the request; it is written back marked "inferred"
  --exploratory         the request reads as exploratory, so an inferred implement is asked about first
`;

export type PrimaryCommand = "enqueue" | "reply" | "create" | "block";

const VALUE_FLAGS = ["--type", "--entry", "--inferred", "--project"] as const;
type Flags = Partial<Record<(typeof VALUE_FLAGS)[number], string>>;

/** Splits args into flag values and positionals; everything after `--` is positional. Undefined when a flag is missing its value. */
export function parseArgs(args: string[]): { flags: Flags; exploratory: boolean; words: string[] } | undefined {
  const flags: Flags = {};
  const words: string[] = [];
  let exploratory = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (a === "--exploratory") exploratory = true;
    else if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      const v = args[++i];
      if (!v) return undefined;
      flags[a as (typeof VALUE_FLAGS)[number]] = v;
    } else words.push(a);
  }
  return { flags, exploratory, words };
}

/** The ref the merge policy is read from: the project's default branch, never the working tree. */
function defaultRef(repo: string): string {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "main";
  }
}

export async function primaryCommand(command: PrimaryCommand, args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const words = parsed?.words ?? [];
  const wrongShape = !parsed || words.length === 0 || (command === "reply" && words.length < 2) || (command === "block" && words.length !== 2);
  if (wrongShape) {
    console.error(USAGE.trimEnd());
    return 2;
  }
  const { flags, exploratory } = parsed;
  const intake = {
    ...(flags["--type"] && { workType: flags["--type"] }),
    ...(flags["--entry"] && { entryType: flags["--entry"] }),
    ...(flags["--inferred"] && { inferred: { workType: flags["--inferred"], ...(exploratory && { exploratory }) } }),
  };
  const repo = resolve(flags["--project"] ?? ".");
  try {
    const config = loadAdapterDoc(join(repo, ADAPTER_DOC_PATH)).tracker;
    const tracker = await createLinearTracker(config, { apiKey: resolveCredential(config.credentials) });
    if (command === "reply") {
      console.log(await replyToEscalation(tracker, words[0]!, words.slice(1).join(" ")));
      return 0;
    }
    if (command === "block") {
      console.log(await addBlockerEdge(tracker, words[0]!, words[1]!));
      return 0;
    }
    const deps = { tracker, policy: new GitPolicy(repo, defaultRef(repo)), nudge: (t: string) => sendNudge(join(abtHome(), "runner.sock"), t) };
    if (command === "create") {
      const result = await enqueueFreeText(deps, { text: words.join(" "), ...intake });
      console.log(result.reply);
      return result.outcome === "queued" ? 0 : 1;
    }
    // A ticket may carry its own type as `ABT-1:research`, which beats the flags like a typed command does.
    const requests = words.map((w) => {
      const [, ticket, type] = /^([^:]+)(?::(.+))?$/.exec(w)!;
      return { ticket: ticket!, ...intake, ...(type && { workType: type }) };
    });
    if (requests.length > 1) {
      const result = await enqueueBatch(deps, requests);
      console.log(result.reply);
      return result.rows.length > 0 && result.rows.every((r) => r.outcome === "queued") ? 0 : 1;
    }
    const result = await enqueueOne(deps, requests[0]!);
    console.log(result.reply);
    return result.outcome === "queued" ? 0 : 1;
  } catch (e) {
    console.error(`abt: ${(e as Error).message}`);
    return 1;
  }
}
