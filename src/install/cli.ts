import { execFile, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { abtHome } from "../log/store.ts";
import { GitSource } from "./git-source.ts";
import { InstallError, InstallStore } from "./store.ts";
import { upgrade, type InstallSelfTest } from "./upgrade.ts";

const run = promisify(execFile);

const USAGE = `usage: abt upgrade <tag> [--from <repo>]
       abt upgrade --list

Installs <tag> under the abt folder, runs its startup self-test and switches the current install to it
only if the test passes. A tag that is already installed is a rollback: it just becomes current.
<repo> is a git URL or path; default $ABT_REPO, else the origin of the abt that is running.
`;

/** The self-test of an install is run by that install: \`<dir>/bin/abt selftest\`. */
export const runInstalledSelfTest: InstallSelfTest = async (dir) => {
  try {
    await run(join(dir, "bin", "abt"), ["selftest"], { env: { ...process.env, ABT_PINNED_RUN: "1" } });
    return { ok: true, failures: [] };
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`.trim();
    return { ok: false, failures: out === "" ? [`${join(dir, "bin", "abt")} selftest failed: ${(e as Error).message}`] : out.split("\n") };
  }
};

function defaultRepo(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ABT_REPO) return env.ABT_REPO;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function upgradeCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const store = new InstallStore(abtHome(env));
  if (args[0] === "--list") {
    const cur = store.current();
    for (const t of store.list()) console.log(`${t === cur ? "*" : " "} ${t}`);
    return 0;
  }
  const from = args.indexOf("--from");
  const repo = from >= 0 ? args[from + 1] : defaultRepo(env);
  const tag = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--from");
  if (!tag || (from >= 0 && !args[from + 1])) {
    console.error(USAGE.trimEnd());
    return 2;
  }
  if (!repo && !store.has(tag)) {
    console.error("abt upgrade: no source repository: pass --from <repo> or set ABT_REPO");
    return 2;
  }
  try {
    const r = await upgrade(tag, { store, source: new GitSource(repo ?? ""), selfTest: runInstalledSelfTest });
    switch (r.status) {
      case "upgraded":
        console.log(`upgraded: ${r.from ?? "no install"} -> ${r.to}`);
        return 0;
      case "rolled-back":
        console.log(`rolled back: ${r.from ?? "no install"} -> ${r.to}`);
        return 0;
      case "unchanged":
        console.log(`${r.to} is already current`);
        return 0;
      case "failed":
        console.error(`abt upgrade: ${r.tag} not installed, current stays ${r.current ?? "unset"}:`);
        for (const f of r.failures) console.error(f);
        return 1;
    }
  } catch (e) {
    if (e instanceof InstallError) {
      console.error(`abt upgrade: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
