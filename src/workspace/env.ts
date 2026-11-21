import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** From the adapter doc's `isolation` section: what a worker's real-app verification must not share with another worker. */
export interface IsolationConfig {
  /** Name -> base port. A worker's port is the base plus its lane number. */
  ports: Record<string, number>;
  /** Database name template; `{ticket}` and `{lane}` are replaced. */
  database?: string;
  /** Build output directory template, relative to the worktree unless absolute; `{ticket}` and `{lane}` are replaced. */
  buildDir?: string;
}

export interface WorkerEnv {
  lane: number;
  ports: Record<string, number>;
  database?: string;
  buildDir?: string;
  /** The same, as environment variables for the worker: ABT_LANE, ABT_PORT_<NAME>, ABT_DATABASE, ABT_BUILD_DIR. */
  vars: Record<string, string>;
}

/**
 * Hands each ticket's worker its own lane, and so its own ports, database and build output. Lanes are the
 * lowest free number among tickets that hold one, kept in `<dir>/.lanes.json` so a restart sees them; a lane
 * is freed when its ticket's worktree is removed.
 */
export class WorkerEnvs {
  readonly #file: string;
  readonly #config: IsolationConfig | undefined;

  constructor(dir: string, config: IsolationConfig | undefined) {
    this.#file = join(dir, ".lanes.json");
    this.#config = config;
  }

  allocate(ticket: string, worktree: string): WorkerEnv {
    const lanes = this.#read();
    let lane = lanes[ticket];
    if (lane === undefined) {
      const used = new Set(Object.values(lanes));
      lane = 0;
      while (used.has(lane)) lane++;
      lanes[ticket] = lane;
      this.#write(lanes);
    }
    return this.#env(ticket, lane, worktree);
  }

  release(ticket: string): void {
    const lanes = this.#read();
    if (!(ticket in lanes)) return;
    delete lanes[ticket];
    this.#write(lanes);
  }

  #env(ticket: string, lane: number, worktree: string): WorkerEnv {
    const c = this.#config;
    if (!c) return { lane, ports: {}, vars: {} };
    const fill = (t: string, name: string) => t.replaceAll("{lane}", String(lane)).replaceAll("{ticket}", name);
    const ports = Object.fromEntries(Object.entries(c.ports).map(([n, base]) => [n, base + lane]));
    const database = c.database === undefined ? undefined : fill(c.database, ticket.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    const dirName = c.buildDir === undefined ? undefined : fill(c.buildDir, ticket);
    const buildDir = dirName === undefined ? undefined : dirName.startsWith("/") ? dirName : join(worktree, dirName);
    const vars: Record<string, string> = { ABT_LANE: String(lane) };
    for (const [n, p] of Object.entries(ports)) vars[`ABT_PORT_${n.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] = String(p);
    if (database !== undefined) vars.ABT_DATABASE = database;
    if (buildDir !== undefined) vars.ABT_BUILD_DIR = buildDir;
    return { lane, ports, ...(database !== undefined && { database }), ...(buildDir !== undefined && { buildDir }), vars };
  }

  #read(): Record<string, number> {
    try {
      return existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  #write(lanes: Record<string, number>): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(lanes));
    renameSync(tmp, this.#file);
  }
}
