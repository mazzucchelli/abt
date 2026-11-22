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

/**
 * Seam 1: runs one process to completion. Tests replace it with recorded output. `onStdout` gets each chunk
 * as it arrives, so a caller can keep a live transcript; the full output is still returned at the end.
 */
export type Spawner = (spec: SpawnSpec, onStdout?: (chunk: string) => void) => Promise<SpawnResult>;

export const systemSpawner: Spawner = (spec, onStdout) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => {
      out.push(d);
      onStdout?.(d.toString("utf8"));
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
