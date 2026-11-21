import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { abtHome } from "../log/store.ts";
import { GitPolicy } from "../landing/policy.ts";
import { sendNudge } from "../runner/socket.ts";
import { ADAPTER_DOC_PATH, loadAdapterDoc } from "../tracker/config.ts";
import { resolveCredential } from "../tracker/credentials.ts";
import { createLinearTracker } from "../tracker/linear.ts";
import { enqueueTicket, replyToEscalation } from "./enqueue.ts";

const USAGE = `usage: abt enqueue <ticket> [--type <work type>] [--project <dir>]
       abt reply <ticket> <text...> [--project <dir>]

enqueue   hand a ticket to abt as one work type: one tracker write, a nudge, a one-line ack
reply     write a chat reply to an escalation on the ticket as the owner's comment
`;

/** Pulls `--flag value` out of args, returning the value and the rest. */
function takeFlag(args: string[], flag: string): { value: string | undefined; rest: string[] } {
  const i = args.indexOf(flag);
  if (i < 0) return { value: undefined, rest: args };
  return { value: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** The ref the merge policy is read from: the project's default branch, never the working tree. */
function defaultRef(repo: string): string {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "main";
  }
}

export async function primaryCommand(command: "enqueue" | "reply", args: string[]): Promise<number> {
  const type = takeFlag(args, "--type");
  const proj = takeFlag(type.rest, "--project");
  const [ticket, ...words] = proj.rest;
  if (!ticket || (command === "reply" && words.length === 0) || (command === "enqueue" && words.length > 0) || (type.rest.includes("--type") && !type.value)) {
    console.error(USAGE.trimEnd());
    return 2;
  }
  const repo = resolve(proj.value ?? ".");
  try {
    const config = loadAdapterDoc(join(repo, ADAPTER_DOC_PATH)).tracker;
    const tracker = await createLinearTracker(config, { apiKey: resolveCredential(config.credentials) });
    if (command === "reply") {
      console.log(await replyToEscalation(tracker, ticket, words.join(" ")));
      return 0;
    }
    const result = await enqueueTicket(
      { tracker, policy: new GitPolicy(repo, defaultRef(repo)), nudge: (t) => sendNudge(join(abtHome(), "runner.sock"), t) },
      { ticket, ...(type.value && { workType: type.value }) },
    );
    console.log(result.reply);
    return result.outcome === "queued" ? 0 : 1;
  } catch (e) {
    console.error(`abt: ${(e as Error).message}`);
    return 1;
  }
}
