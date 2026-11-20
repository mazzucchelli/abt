import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export class GlobalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalConfigError";
  }
}

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface GlobalConfig {
  projects: ProjectEntry[];
}

/** `<abt home>/config.yaml`: the onboarded projects one runner serves. A missing file is no projects. */
export function loadGlobalConfig(home: string): GlobalConfig {
  const file = join(home, "config.yaml");
  if (!existsSync(file)) return { projects: [] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new GlobalConfigError(`${file} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const list = (raw as { projects?: unknown } | null)?.projects ?? [];
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
    return { name, path: o.path as string };
  });
  return { projects };
}
