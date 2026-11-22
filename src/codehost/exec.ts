import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs a command and resolves to its stdout. Injected so the adapters are testable without git or gh. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

export const systemExec: Exec = async (cmd, args, opts) => (await run(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 })).stdout;

export const errorText = (e: unknown) => `${(e as Error).message} ${(e as { stderr?: string }).stderr ?? ""}`;
