import { spawn } from "node:child_process";

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnResult {
  /** Null when the process was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Seam 1: runs one process to completion. Tests replace it with recorded output. */
export type Spawner = (spec: SpawnSpec) => Promise<SpawnResult>;

export const systemSpawner: Spawner = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
