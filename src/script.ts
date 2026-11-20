import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { Result } from "./log/record.ts";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

export interface ScriptVerdict {
  /** ok = true, fail = false, error = the check itself could not give an answer. */
  result: Extract<Result, "ok" | "fail" | "error">;
  why: string;
}

/**
 * Runs a custom check script from `dir`: exit 0 means true, exit 1 means false, and anything
 * else (another exit code, a signal, a script that will not start, a timeout) is an error.
 * An error is never read as false, so it cannot be mistaken for a failed check.
 */
export function runScript(dir: string, name: string, timeoutMs: number): Promise<ScriptVerdict> {
  const file = resolve(dir, name);
  if (!file.startsWith(resolve(dir) + sep)) {
    return Promise.resolve({ result: "error", why: `script "${name}" is outside ${dir}` });
  }
  return new Promise((done) => {
    let settled = false;
    const finish = (v: ScriptVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(v);
    };
    // Own process group, so a timeout kills what the script started too.
    const child = spawn(file, [], { cwd: dir, stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ result: "error", why: `script "${name}" timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e) => finish({ result: "error", why: `script "${name}" could not run: ${(e as NodeJS.ErrnoException).code ?? e.message}` }));
    child.on("exit", (code, signal) => {
      if (code === 0) finish({ result: "ok", why: `script "${name}" exited 0` });
      else if (code === 1) finish({ result: "fail", why: `script "${name}" exited 1` });
      else finish({ result: "error", why: signal ? `script "${name}" was killed by ${signal}` : `script "${name}" exited ${code}` });
    });
  });
}
