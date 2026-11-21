import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLaunchProfile } from "../harness/claude/profile.ts";
import { runSelfTest } from "../harness/claude/selftest.ts";
import { systemSpawner } from "../harness/claude/spawn.ts";
import { resolveCredential } from "../tracker/credentials.ts";

/**
 * `abt selftest`: the startup self-test of THIS install against the real Claude Code, with the
 * launch profile's plugin dir set to this install. `abt upgrade` runs it on the new install and
 * switches to it only on exit 0.
 */
export async function selfTestCommand(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  try {
    const profile = loadLaunchProfile({ home: homedir(), pluginDir: root });
    const token = resolveCredential({ keychain: profile.keychainItem });
    const report = await runSelfTest({ profile, spawn: systemSpawner, token, hostEnv: env, workDir: mkdtempSync(join(tmpdir(), "abt-selftest-")) });
    for (const c of report.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    return report.ok ? 0 : 1;
  } catch (e) {
    console.error(`abt selftest: ${(e as Error).message}`);
    return 1;
  }
}
