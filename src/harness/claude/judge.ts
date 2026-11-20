import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildLaunch, injectedSettings } from "./launch.ts";
import type { ClaudeSubscriptionProfile } from "./profile.ts";
import type { Spawner } from "./spawn.ts";
import type { UsageLimit } from "../contract.ts";
import { parseStream, usageLimitOf } from "./stream.ts";

export class JudgeError extends Error {
  /** Set when the judge hit the subscription's usage limit, so the runner can hold until the reset. */
  readonly usageLimit?: UsageLimit;
  constructor(message: string, usageLimit?: UsageLimit) {
    super(message);
    this.name = "JudgeError";
    if (usageLimit) this.usageLimit = usageLimit;
  }
}

export interface JudgeDeps {
  profile: ClaudeSubscriptionProfile;
  spawn: Spawner;
  token: string;
  hostEnv: Record<string, string | undefined>;
  workDir: string;
}

/** One judge call: pinned Haiku through the subscription profile, structured output checked against the schema. */
export async function runJudge<T = unknown>(d: JudgeDeps, q: { prompt: string; schema: object }): Promise<T> {
  mkdirSync(d.workDir, { recursive: true });
  const settingsPath = join(d.workDir, "judge-settings.json");
  writeFileSync(settingsPath, injectedSettings());
  const spec = buildLaunch({
    kind: "judge", profile: d.profile, token: d.token, hostEnv: d.hostEnv, settingsPath, sessionId: crypto.randomUUID(),
    cwd: d.workDir, prompt: q.prompt, schema: q.schema,
  });
  const res = await d.spawn(spec);
  const summary = parseStream(res.stdout);
  const { result } = summary;
  const usage = usageLimitOf(summary);
  if (usage) throw new JudgeError(`judge hit the usage limit${usage.resetsAt ? `, resets at epoch ${usage.resetsAt}` : ""}`, usage);
  if (!result) throw new JudgeError(`judge ended without a result (exit ${res.exitCode})`);
  if (result.is_error) throw new JudgeError(`judge failed: ${result.terminal_reason ?? result.subtype ?? "error"}`);
  if (result.structured_output === undefined) throw new JudgeError("judge returned no structured output");
  const validate = new Ajv2020({ strict: false }).compile(q.schema);
  if (!validate(result.structured_output)) {
    throw new JudgeError(`judge output does not match the schema: ${JSON.stringify(validate.errors)}`);
  }
  return result.structured_output as T;
}
