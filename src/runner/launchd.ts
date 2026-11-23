import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const LABEL = "dev.abt.runner";

export interface Launchctl {
  run(args: string[]): Promise<{ code: number; out: string }>;
}

export const systemLaunchctl: Launchctl = {
  run: (args) =>
    new Promise((resolve) => {
      execFile("launchctl", args, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.trim() });
      });
    }),
};

export interface LaunchdDeps {
  launchctl: Launchctl;
  /** Usually ~/Library/LaunchAgents. */
  plistDir: string;
  uid: number;
  /** The global abt home: handed to the runner as ABT_HOME, and where its logs go. */
  home: string;
  /** The command launchd runs: the runner in the foreground. */
  program: string[];
  /**
   * The PATH the daemon (and so its workers) runs with. launchd's own is `/usr/bin:/bin:/usr/sbin:/sbin`, which
   * misses Homebrew's `gh` and `claude`, so `runner start` hands over the PATH of the shell it runs in.
   */
  path?: string;
}

/** Installs and controls the one launchd agent that runs the runner daemon. */
export class LaunchdAgent {
  readonly #d: LaunchdDeps;

  constructor(deps: LaunchdDeps) {
    this.#d = deps;
  }

  get plistPath(): string {
    return join(this.#d.plistDir, `${LABEL}.plist`);
  }

  /** Writes the plist and loads it, replacing a copy that is already loaded. */
  async start(): Promise<void> {
    mkdirSync(this.#d.plistDir, { recursive: true });
    mkdirSync(this.#d.home, { recursive: true });
    writeFileSync(this.plistPath, plist(this.#d));
    await this.#d.launchctl.run(["bootout", `gui/${this.#d.uid}/${LABEL}`]);
    await this.#ok(["bootstrap", `gui/${this.#d.uid}`, this.plistPath]);
  }

  /** The PATH the installed plist gives the daemon, or undefined when no agent is installed. */
  installedPath(): string | undefined {
    let text: string;
    try {
      text = readFileSync(this.plistPath, "utf8");
    } catch {
      return undefined;
    }
    const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    return unesc(m?.[1] ?? LAUNCHD_PATH);
  }

  /** Unloads the agent and removes its plist, so it neither restarts nor returns at login. */
  async stop(): Promise<void> {
    const r = await this.#d.launchctl.run(["bootout", `gui/${this.#d.uid}/${LABEL}`]);
    rmSync(this.plistPath, { force: true });
    // Not loaded is a fine place to be stopped from.
    if (r.code !== 0 && !/not find|no such|not loaded|Boot-out failed: 3/i.test(r.out) && r.code !== 3) {
      throw new Error(`launchctl bootout failed (${r.code}): ${r.out}`);
    }
  }

  async #ok(args: string[]): Promise<void> {
    const r = await this.#d.launchctl.run(args);
    if (r.code !== 0) throw new Error(`launchctl ${args[0]} failed (${r.code}): ${r.out}`);
  }
}

/** The PATH launchd gives an agent whose plist sets none. */
export const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Where `command` resolves on `path`, as a spawn would find it: a name containing a slash is taken as given, a bare
 * name is looked up in each PATH entry. Undefined when it isn't there or isn't executable.
 */
export function which(command: string, path: string): string | undefined {
  const candidates = command.includes("/") ? [command] : path.split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, command));
  return candidates.find((file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The commands of `commands` that `path` can't find, each with why the daemon needs it. */
export function missingOnPath(commands: { command: string; why: string }[], path: string): string[] {
  return commands.filter((c) => !which(c.command, path)).map((c) => `${c.command} (${c.why}) is not on the runner's PATH ${path}`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function plist(d: Pick<LaunchdDeps, "program" | "home" | "path">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${d.program.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ABT_HOME</key>
    <string>${esc(d.home)}</string>
${d.path === undefined ? "" : `    <key>PATH</key>\n    <string>${esc(d.path)}</string>\n`}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(join(d.home, "runner.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(d.home, "runner.err.log"))}</string>
</dict>
</plist>
`;
}
