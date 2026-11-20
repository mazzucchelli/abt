import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface ClaudeSubscriptionProfile {
  binary: string;
  /** Oldest Claude Code that resolves the pinned model IDs and has the retry watchdog. */
  minVersion: string;
  /** Keychain item holding the long-lived OAuth token. Never the token itself. */
  keychainItem: string;
  /** Pinned model IDs, never aliases: an alias drifts with the CLI version. */
  models: { sonnet: string; opus: string; haiku: string };
  /** The pinned abt install, loaded with `--plugin-dir`. */
  pluginDir: string;
  /** Where run transcripts and per-run settings go. */
  runsDir: string;
  /** Caps on how long the CLI's retry watchdog may wait before the run ends as an infrastructure error. */
  retryWatchdog: { maxWaitMs: number; maxUsageLimitWaitMs: number };
}

export interface ProfileContext {
  home: string;
  pluginDir: string;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".agents", "abt", "config.yaml");
const PINNED = /^claude-[a-z0-9][a-z0-9.-]*$/;
const KEYS = ["binary", "min-version", "keychain", "models", "plugin-dir", "runs-dir", "max-wait-minutes", "max-usage-limit-wait-minutes"];

export function loadLaunchProfile(ctx: ProfileContext, path = GLOBAL_CONFIG_PATH): ClaudeSubscriptionProfile {
  let source = "{}";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    // no global config yet: defaults apply
  }
  return parseLaunchProfile(source, ctx);
}

/** Parse the `claude-subscription` launch profile from the global config (YAML). Unset keys take defaults. */
export function parseLaunchProfile(source: string, ctx: ProfileContext): ClaudeSubscriptionProfile {
  let raw: unknown;
  try {
    raw = parse(source) ?? {};
  } catch (e) {
    throw new ProfileError(`global config is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const profiles = obj(obj(raw, "global config")["launch-profiles"] ?? {}, "launch-profiles");
  const p = obj(profiles["claude-subscription"] ?? {}, "launch-profiles.claude-subscription");
  for (const k of Object.keys(p)) {
    if (!KEYS.includes(k)) throw new ProfileError(`unknown key "${k}" in launch-profiles.claude-subscription`);
  }
  const keychain = str(p.keychain, "keychain", "abt-claude-oauth");
  if (/^sk-ant-/.test(keychain)) throw new ProfileError("keychain must be a Keychain item name, not a secret");
  const m = obj(p.models ?? {}, "models");
  const model = (k: "sonnet" | "opus" | "haiku", d: string) => {
    const v = str(m[k], `models.${k}`, d);
    if (!PINNED.test(v)) throw new ProfileError(`models.${k} must be a pinned model ID like ${d}, not the alias "${v}"`);
    return v;
  };
  return {
    binary: str(p.binary, "binary", "claude"),
    minVersion: str(p["min-version"], "min-version", "2.1.293"),
    keychainItem: keychain,
    models: { sonnet: model("sonnet", "claude-sonnet-5-5"), opus: model("opus", "claude-opus-5-5"), haiku: model("haiku", "claude-haiku-5-5") },
    pluginDir: str(p["plugin-dir"], "plugin-dir", ctx.pluginDir),
    runsDir: str(p["runs-dir"], "runs-dir", join(ctx.home, ".agents", "abt", "runs")),
    retryWatchdog: {
      maxWaitMs: minutes(p["max-wait-minutes"], "max-wait-minutes", 10),
      maxUsageLimitWaitMs: minutes(p["max-usage-limit-wait-minutes"], "max-usage-limit-wait-minutes", 30),
    },
  };
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProfileError(`${where} must be a mapping`);
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, d: string): string {
  if (v === undefined) return d;
  if (typeof v !== "string" || v.trim() === "") throw new ProfileError(`${where} must be a non-empty string`);
  return v;
}

function minutes(v: unknown, where: string, d: number): number {
  if (v === undefined) return d * 60_000;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ProfileError(`${where} must be a positive number of minutes`);
  return Math.round(v * 60_000);
}
