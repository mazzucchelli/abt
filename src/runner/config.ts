import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { GRADES } from "../routing.ts";
import type { SchedulingConfig } from "./scheduler.ts";

export class GlobalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalConfigError";
  }
}

export interface ProjectEntry {
  name: string;
  path: string;
  /** Cap on this project's running workers, below the global cap. */
  maxWorkers?: number;
}

export interface GlobalConfig {
  projects: ProjectEntry[];
  scheduling: SchedulingConfig;
}

function positive(file: string, where: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new GlobalConfigError(`${file}: ${where} must be a whole number of at least 1`);
  return v;
}

/** `<abt home>/config.yaml`: the onboarded projects one runner serves. A missing file is no projects. */
export function loadGlobalConfig(home: string): GlobalConfig {
  const file = join(home, "config.yaml");
  if (!existsSync(file)) return { projects: [], scheduling: {} };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new GlobalConfigError(`${file} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const top = (raw ?? {}) as { projects?: unknown; maxWorkers?: unknown; wallClockMinutes?: unknown };
  const scheduling: SchedulingConfig = {};
  if (top.maxWorkers !== undefined) scheduling.globalCap = positive(file, "maxWorkers", top.maxWorkers);
  if (top.wallClockMinutes !== undefined) {
    const caps = (top.wallClockMinutes ?? {}) as Record<string, unknown>;
    scheduling.wallClockMinutes = {};
    for (const [grade, v] of Object.entries(caps)) {
      if (!(GRADES as readonly string[]).includes(grade)) throw new GlobalConfigError(`${file}: wallClockMinutes.${grade} is not a grade (${GRADES.join(", ")})`);
      scheduling.wallClockMinutes[grade as (typeof GRADES)[number]] = positive(file, `wallClockMinutes.${grade}`, v);
    }
  }
  const list = top.projects ?? [];
  if (!Array.isArray(list)) throw new GlobalConfigError(`${file}: projects must be a list`);
  const seen = new Set<string>();
  const projects = list.map((p, i): ProjectEntry => {
    const o = (p ?? {}) as Record<string, unknown>;
    for (const key of ["name", "path"]) {
      if (typeof o[key] !== "string" || o[key].trim() === "") throw new GlobalConfigError(`${file}: projects[${i}].${key} must be a non-empty string`);
    }
    const name = o.name as string;
    if (seen.has(name)) throw new GlobalConfigError(`${file}: duplicate project "${name}"`);
    seen.add(name);
    return { name, path: o.path as string, ...(o.maxWorkers !== undefined && { maxWorkers: positive(file, `projects[${i}].maxWorkers`, o.maxWorkers) }) };
  });
  return { projects, scheduling };
}
