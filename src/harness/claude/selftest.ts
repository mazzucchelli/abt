import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowedHostEnv, buildLaunch, injectedSettings } from "./launch.ts";
import type { ClaudeSubscriptionProfile } from "./profile.ts";
import type { Spawner } from "./spawn.ts";
import { parseStream } from "./stream.ts";

export interface SelfTestDeps {
  profile: ClaudeSubscriptionProfile;
  spawn: Spawner;
  token: string;
  hostEnv: Record<string, string | undefined>;
  /** Scratch directory for the dummy hook's marker and the injected settings. */
  workDir: string;
}

export interface SelfTestCheck {
  name: "stop-hook" | "no-user-plugins" | "model-ids";
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  checks: SelfTestCheck[];
}

export class SelfTestError extends Error {
  readonly report: SelfTestReport;
  constructor(report: SelfTestReport) {
    const bad = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    super(`startup self-test failed, dispatch refused:\n${bad.join("\n")}`);
    this.name = "SelfTestError";
    this.report = report;
  }
}

/**
 * Seam 2: the startup self-test against real Claude Code. It launches tiny headless runs under the
 * same flags and injected settings a worker gets and checks three things: a dummy Stop hook fires,
 * no user plugins load, and every pinned model ID resolves to itself on a CLI new enough for them.
 */
export async function runSelfTest(d: SelfTestDeps): Promise<SelfTestReport> {
  const { profile } = d;
  mkdirSync(d.workDir, { recursive: true });
  const marker = join(d.workDir, "stop-hook-fired");
  rmSync(marker, { force: true });
  const settingsPath = join(d.workDir, "selftest-settings.json");
  writeFileSync(
    settingsPath,
    injectedSettings({ hooks: { Stop: [{ hooks: [{ type: "command", command: `touch '${marker.replace(/'/g, "'\\''")}'` }] }] } }),
  );

  const models = [...new Set([profile.models.haiku, profile.models.sonnet, profile.models.opus])];
  const problems: string[] = [];
  let first: ReturnType<typeof parseStream> | undefined;

  const version = await versionOf(d);
  if (!version) problems.push("could not read the Claude Code version");
  else if (compare(version, profile.minVersion) < 0) problems.push(`Claude Code ${version} is older than the required ${profile.minVersion}`);

  for (const model of models) {
    const spec = buildLaunch({
      kind: "worker", profile, token: d.token, hostEnv: d.hostEnv, settingsPath, sessionId: crypto.randomUUID(), cwd: d.workDir,
      prompt: "Reply with just: ok", model, effort: "low",
    });
    let res;
    try {
      res = await d.spawn(spec);
    } catch (e) {
      problems.push(`${model}: could not launch ${profile.binary}: ${(e as Error).message}`);
      continue;
    }
    const s = parseStream(res.stdout);
    first ??= s;
    if (res.stderr.includes("unrecognized_model")) problems.push(`${model}: Claude Code reports unrecognized_model`);
    else if (!s.init) problems.push(`${model}: no init event (${(res.stderr.trim().split("\n").at(-1) ?? "no output").slice(0, 200)})`);
    else if (s.init.model !== model) problems.push(`${model}: resolved to ${s.init.model}`);
    else if (!s.result || s.result.is_error) problems.push(`${model}: the run failed (${s.result?.terminal_reason ?? "no result"})`);
    else if (!(model in (s.result.modelUsage ?? {}))) problems.push(`${model}: modelUsage does not list it`);
  }

  const scrub = (s: string) => (d.token ? s.split(d.token).join("[redacted]") : s);
  const checks: SelfTestCheck[] = [
    existsSync(marker)
      ? { name: "stop-hook", ok: true, detail: "the dummy Stop hook fired under the injected settings" }
      : { name: "stop-hook", ok: false, detail: "the dummy Stop hook did not fire under the injected settings" },
    pluginsCheck(first, profile),
    problems.length === 0
      ? { name: "model-ids", ok: true, detail: `${models.join(", ")} resolve on Claude Code ${version}` }
      : { name: "model-ids", ok: false, detail: problems.join("; ") },
  ];
  return { ok: checks.every((c) => c.ok), checks: checks.map((c) => ({ ...c, detail: scrub(c.detail) })) };
}

function pluginsCheck(s: ReturnType<typeof parseStream> | undefined, profile: ClaudeSubscriptionProfile): SelfTestCheck {
  if (!s?.init) return { name: "no-user-plugins", ok: false, detail: "no init event to read the loaded plugins from" };
  const plugins: { name?: string; path?: string; source?: string }[] = s.init.plugins ?? [];
  const pinned = resolve(profile.pluginDir);
  const user = plugins.filter(
    (p) => !String(p.source ?? "").endsWith("@builtin") && !(p.path && resolve(p.path) === pinned),
  );
  return user.length === 0
    ? { name: "no-user-plugins", ok: true, detail: "only built-in plugins and the pinned abt install loaded" }
    : { name: "no-user-plugins", ok: false, detail: `user plugins loaded: ${user.map((p) => p.name ?? p.source).join(", ")}` };
}

async function versionOf(d: SelfTestDeps): Promise<string | undefined> {
  try {
    const r = await d.spawn({ command: d.profile.binary, args: ["--version"], cwd: d.workDir, env: allowedHostEnv(d.hostEnv) });
    return /\d+\.\d+\.\d+/.exec(r.stdout)?.[0];
  } catch {
    return undefined;
  }
}

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** A `ready` hook for the adapter: runs the self-test before dispatch, remembers a pass, and re-runs after a failure. */
export function selfTestGate(d: Omit<SelfTestDeps, "token">, readToken: () => string): () => Promise<void> {
  let passed = false;
  return async () => {
    if (passed) return;
    const report = await runSelfTest({ ...d, token: readToken() });
    if (!report.ok) throw new SelfTestError(report);
    passed = true;
  };
}
