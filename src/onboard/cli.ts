import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { abtHome } from "../log/store.ts";
import { BUNDLE_PATHS, buildBundle, openOnboardingPr } from "./bundle.ts";
import { GhHost, GhProbe, GitFiles, remoteDefaultBranch, systemExec } from "./github.ts";
import { acceptPins, FilePins, settleOnboarding } from "./pins.ts";
import { applyDraft, propose } from "./propose.ts";

const USAGE = `usage: abt onboard probe [options]
       abt onboard open --team <key> [--credentials-env <VAR>] [--draft <policy.yaml>] [options]
       abt onboard settle [options]
       abt onboard pin [options]

probe    read the project's facts and print the proposal: preset, policy draft, matched risk catalogue, gaps
open     open the PR that adds the merge policy, facts snapshot, land tree, adapter doc and a CLAUDE.md pointer
settle   after you merged that PR by hand, record the pins of the protected files (the runner also does this on its scan)
pin      record the pins again from the default branch, after you read a change to a protected file and agree with it

options:
  --project <dir>     the project checkout (default: .)
  --no-write-apps     you checked that no installed GitHub App can write to the repo (a user token can't read that)
  --draft <file>      the merge policy as you edited it from the proposal
`;

const VALUE_FLAGS = ["--project", "--team", "--credentials-env", "--draft"];

function parse(args: string[]): { flags: Record<string, string>; noApps: boolean } | undefined {
  const flags: Record<string, string> = {};
  let noApps = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-write-apps") noApps = true;
    else if (VALUE_FLAGS.includes(a) && args[i + 1] !== undefined) flags[a] = args[++i]!;
    else return undefined;
  }
  return { flags, noApps };
}

export async function onboardCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const parsed = parse(rest);
  if (!sub || !["probe", "open", "settle", "pin"].includes(sub) || !parsed) {
    console.error(USAGE.trimEnd());
    return 2;
  }
  const repo = resolve(parsed.flags["--project"] ?? ".");
  try {
    const home = abtHome();
    const pins = new FilePins(home);
    await systemExec("git", ["fetch", "origin"], { cwd: repo });
    const branch = await remoteDefaultBranch(repo);
    const probe = new GhProbe({ repo, confirmedNoWriteApps: parsed.noApps });
    const host = new GhHost({ repo, defaultBranch: branch });
    const files = new GitFiles(repo, branch);
    const project = (await probe.facts()).id;

    if (sub === "settle") {
      const outcome = await settleOnboarding({ host, files, pins, project });
      console.log(
        outcome === "none" ? "no onboarding PR is pending"
        : outcome === "waiting" ? "the onboarding PR is still open: merge it by hand; until then the project is pr-only"
        : outcome === "closed" ? "the onboarding PR was closed unmerged: nothing is pinned and the project stays pr-only"
        : "the onboarding PR is merged: the protected files are pinned",
      );
      return 0;
    }
    if (sub === "pin") {
      if (process.env.ABT_ROLE === "worker") {
        console.error("abt: only the owner re-pins protected files; a worker may not");
        return 1;
      }
      const recorded = await acceptPins({ files, pins, project });
      console.log(`pinned ${Object.keys(recorded.files).length} protected file(s) for ${project}`);
      return 0;
    }

    let proposal = await propose(probe);
    if (parsed.flags["--draft"]) proposal = applyDraft(proposal, readFileSync(parsed.flags["--draft"], "utf8"));
    if (sub === "probe") {
      console.log(JSON.stringify(proposal, null, 2));
      return 0;
    }

    const team = parsed.flags["--team"];
    if (!team) {
      console.error(USAGE.trimEnd());
      return 2;
    }
    const claudeMd = await files.read(BUNDLE_PATHS.claude);
    const landTree = readFileSync(fileURLToPath(new URL("../../defaults/trees/land.yaml", import.meta.url)), "utf8");
    const bundle = buildBundle({
      proposal, landTree, ...(claudeMd !== undefined && { claudeMd }),
      tracker: { team, credentials: { env: parsed.flags["--credentials-env"] ?? "LINEAR_API_KEY" } },
    });
    const pr = await openOnboardingPr(host, proposal, bundle);
    await pins.writePending(project, pr.number);
    console.log(`Opened ${pr.url}. Merge it by hand; until then ${project} is pr-only. On that merge the runner pins the protected files.`);
    return 0;
  } catch (e) {
    console.error(`abt: ${(e as Error).message}`);
    return 1;
  }
}
