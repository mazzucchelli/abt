import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  LIFECYCLE_STATES,
  RISK_TIERS,
  WORK_TYPES,
  type LifecycleState,
  type RiskTier,
  type WorkType,
} from "./contract.ts";

export class AdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigError";
  }
}

/** A credential is referenced by name, never held: an env var or a Keychain item. */
export type CredentialRef = { env: string } | { keychain: string };

export interface LabelConfig {
  abt: string;
  workType: Record<WorkType, string>;
  risk: Record<RiskTier, string>;
}

export interface TrackerConfig {
  kind: "linear";
  team: string;
  credentials: CredentialRef;
  /** Lifecycle state -> the tracker's own state name. */
  states: Record<LifecycleState, string>;
  labels: LabelConfig;
}

export interface AdapterConfig {
  tracker: TrackerConfig;
}

export const ADAPTER_DOC_PATH = ".agents/abt/workflow.md";

export function loadAdapterDoc(path: string): AdapterConfig {
  return parseAdapterDoc(readFileSync(path, "utf8"));
}

/** Parse the front matter of the adapter doc. Throws AdapterConfigError on anything wrong. */
export function parseAdapterDoc(source: string): AdapterConfig {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!m) throw new AdapterConfigError("adapter doc has no YAML front matter");
  let raw: unknown;
  try {
    raw = parse(m[1]!);
  } catch (e) {
    throw new AdapterConfigError(`adapter doc front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const root = object(raw, "front matter");
  noExtra(root, ["tracker"], "front matter");
  const t = object(root.tracker, "tracker");
  noExtra(t, ["kind", "team", "credentials", "states", "labels"], "tracker");

  if (t.kind !== "linear") {
    throw new AdapterConfigError(`unsupported tracker ${JSON.stringify(t.kind)} (supported: "linear")`);
  }
  return {
    tracker: {
      kind: "linear",
      team: text(t.team, "tracker.team"),
      credentials: credentials(t.credentials),
      states: states(t.states),
      labels: labels(t.labels),
    },
  };
}

function object(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new AdapterConfigError(`${where} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

function text(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new AdapterConfigError(`${where} must be a non-empty string`);
  return v;
}

function noExtra(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new AdapterConfigError(`unknown key "${k}" in ${where}`);
  }
}

function credentials(v: unknown): CredentialRef {
  const o = object(v, "tracker.credentials");
  const keys = Object.keys(o);
  if (keys.length !== 1 || (keys[0] !== "env" && keys[0] !== "keychain")) {
    throw new AdapterConfigError(
      "tracker.credentials must be exactly one of `env: <VAR>` or `keychain: <item name>`; secrets never go in the file",
    );
  }
  if (keys[0] === "env") {
    const name = text(o.env, "tracker.credentials.env");
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new AdapterConfigError(
        "tracker.credentials.env must be an environment variable name like LINEAR_API_KEY, not a secret",
      );
    }
    return { env: name };
  }
  const name = text(o.keychain, "tracker.credentials.keychain");
  if (/^lin_(api|oauth)_/.test(name)) {
    throw new AdapterConfigError("tracker.credentials.keychain must be a Keychain item name, not a secret");
  }
  return { keychain: name };
}

function states(v: unknown): Record<LifecycleState, string> {
  const o = object(v, "tracker.states");
  noExtra(o, LIFECYCLE_STATES, "tracker.states");
  const out = {} as Record<LifecycleState, string>;
  const owner = new Map<string, LifecycleState>();
  for (const s of LIFECYCLE_STATES) {
    if (o[s] === undefined) {
      throw new AdapterConfigError(
        `lifecycle state "${s}" is not mapped: add it under tracker.states in the adapter doc (all of ${LIFECYCLE_STATES.join(", ")} are required)`,
      );
    }
    out[s] = text(o[s], `tracker.states.${s}`);
    const other = owner.get(out[s]);
    if (other) {
      throw new AdapterConfigError(
        `tracker state "${out[s]}" is mapped to both "${other}" and "${s}": each lifecycle state needs its own tracker state`,
      );
    }
    owner.set(out[s], s);
  }
  return out;
}

function labels(v: unknown): LabelConfig {
  const o = v === undefined ? {} : object(v, "tracker.labels");
  noExtra(o, ["abt", "workType", "risk"], "tracker.labels");
  const wt = o.workType === undefined ? {} : object(o.workType, "tracker.labels.workType");
  noExtra(wt, WORK_TYPES, "tracker.labels.workType");
  const risk = o.risk === undefined ? {} : object(o.risk, "tracker.labels.risk");
  noExtra(risk, RISK_TIERS, "tracker.labels.risk");
  return {
    abt: o.abt === undefined ? "abt" : text(o.abt, "tracker.labels.abt"),
    workType: Object.fromEntries(
      WORK_TYPES.map((w) => [w, wt[w] === undefined ? w : text(wt[w], `tracker.labels.workType.${w}`)]),
    ) as Record<WorkType, string>,
    risk: Object.fromEntries(
      RISK_TIERS.map((r) => [r, risk[r] === undefined ? `risk:${r}` : text(risk[r], `tracker.labels.risk.${r}`)]),
    ) as Record<RiskTier, string>,
  };
}
