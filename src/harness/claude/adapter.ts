import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemSources } from "../../tracker/credentials.ts";
import type { HarnessAdapter, WorkerOutcome, WorkerRequest } from "../contract.ts";
import { buildLaunch, injectedSettings, workerHooks } from "./launch.ts";
import type { ClaudeSubscriptionProfile } from "./profile.ts";
import { systemSpawner, type Spawner } from "./spawn.ts";
import { selfTestGate } from "./selftest.ts";
import { tmpdir } from "node:os";
import { parseStream, usageLimitOf } from "./stream.ts";

export interface ClaudeAdapterDeps {
  profile: ClaudeSubscriptionProfile;
  spawn: Spawner;
  /** Reads the OAuth token at the moment of launch. Never cached. */
  readToken: () => string;
  hostEnv: Record<string, string | undefined>;
  newId?: () => string;
  /** Stamps the live transcript lines. */
  now?: () => Date;
  /** Resolves when dispatch is allowed; rejects to refuse it. Required: in production it is the startup self-test gate. */
  ready: () => Promise<void>;
}

/** Runs workers as headless Claude Code sessions on the subscription, to completion. */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly #d: ClaudeAdapterDeps;

  constructor(deps: ClaudeAdapterDeps) {
    this.#d = deps;
  }

  async run(req: WorkerRequest): Promise<WorkerOutcome> {
    const { profile } = this.#d;
    await this.#d.ready();
    const sessionId = req.session ?? (this.#d.newId ?? randomUUID)();
    const dir = join(profile.runsDir, req.ticket);
    const transcriptPath = join(dir, `${req.node}-${sessionId}.jsonl`);
    const failed = (why: string, exitStatus: number | null = null): WorkerOutcome => ({ result: "error", exitStatus, sessionId, transcriptPath, why });

    const token = this.#d.readToken();
    const settingsPath = join(dir, `${req.node}-${sessionId}.settings.json`);
    const stateFile = join(dir, `${req.node}-${sessionId}.stop-count`);
    let spec;
    try {
      spec = buildLaunch({
        kind: "worker", profile, token, hostEnv: this.#d.hostEnv, settingsPath, sessionId, cwd: req.worktree,
        procedure: req.procedure, prompt: req.prompt, model: req.model, effort: req.effort, feedback: req.feedback.commands,
        ticket: req.ticket, node: req.node, run: req.run ?? sessionId, defaultBranch: req.defaultBranch ?? "main", stateFile,
        ...(req.env && { workerEnv: req.env }),
        ...(req.session && { resume: req.session }),
      });
    } catch (e) {
      return failed((e as Error).message);
    }
    // A node ID is a path (implement/2/0), so the files go in nested folders.
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(settingsPath, injectedSettings({ hooks: workerHooks(profile) }, req.feedback.commands));

    const scrub = (s: string) => (token ? s.split(token).join("[redacted]") : s);
    // The transcript grows while the worker runs, one complete scrubbed line at a time, each stamped with
    // when it arrived (the stream carries no times), so `abt watch` can show live activity.
    let pending = "";
    let streamed = false;
    const stamp = (l: string) => {
      if (!l.trim()) return;
      let text = scrub(l);
      try {
        const e: unknown = JSON.parse(text);
        if (typeof e === "object" && e !== null && !Array.isArray(e)) text = JSON.stringify({ ...e, abt_ts: (this.#d.now?.() ?? new Date()).toISOString() });
      } catch {
        // not JSON: kept as it is
      }
      if (!streamed) writeFileSync(transcriptPath, "");
      streamed = true;
      appendFileSync(transcriptPath, `${text}\n`);
    };
    const onStdout = (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(stamp);
    };
    let res;
    try {
      res = await this.#d.spawn(spec, onStdout);
    } catch (e) {
      stamp(pending);
      return failed(scrub(`could not launch ${profile.binary}: ${(e as Error).message}`));
    }
    stamp(pending);
    if (!streamed) writeFileSync(transcriptPath, scrub(res.stdout));

    const s = parseStream(res.stdout);
    const usage = usageLimitOf(s);
    const id = s.sessionId ?? sessionId;
    const model = s.init?.model ?? req.model;
    const done = (result: WorkerOutcome["result"], why: string): WorkerOutcome => ({
      result, exitStatus: res.exitCode, sessionId: id, transcriptPath, why: scrub(`${why} (model ${model}, effort ${req.effort})`),
      ...(usage && { usageLimit: usage }),
    });

    if (res.stderr.includes("unrecognized_model")) return done("error", `model ${req.model} is not recognised by this Claude Code`);
    if (usage) {
      return done("error", usage.resetsAt ? `usage limit hit (${usage.rateLimitType ?? "unknown"}), resets at epoch ${usage.resetsAt}` : "usage limit hit, reset time unknown");
    }
    if (!s.result) return done("error", `claude ended without a result${res.stderr.trim() ? `: ${res.stderr.trim().split("\n").at(-1)}` : ""}`);
    if (s.result.terminal_reason === "api_error") return done("error", `API error ${s.result.api_error_status ?? ""}`.trim());
    if (s.result.is_error || (res.exitCode ?? 1) !== 0) return done("fail", `worker ended with ${s.result.terminal_reason ?? s.result.subtype ?? "an error"}`);
    return done("ok", "worker finished");
  }
}

/** Read the OAuth token from the Keychain at the moment of use. Never cached or written. */
export function keychainToken(item: string, keychain: (item: string) => string | undefined = systemSources.keychain): string {
  const token = keychain(item);
  if (!token) throw new Error(`Claude Code token not found: add it to the Keychain as "${item}" (from \`claude setup-token\`)`);
  return token;
}

/** The production adapter for the claude-subscription profile: real processes, Keychain token, self-test before any dispatch. */
export function claudeSubscriptionAdapter(profile: ClaudeSubscriptionProfile, hostEnv: Record<string, string | undefined> = process.env, spawn: Spawner = systemSpawner): ClaudeCodeAdapter {
  const readToken = () => keychainToken(profile.keychainItem);
  const ready = selfTestGate({ profile, spawn: systemSpawner, hostEnv, workDir: join(tmpdir(), "abt-selftest") }, readToken);
  return new ClaudeCodeAdapter({ profile, spawn, readToken, hostEnv, ready });
}
