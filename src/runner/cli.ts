import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { systemClock, systemTimers } from "../clock.ts";
import { loadFakeWorld } from "../fake-world.ts";
import { DecisionLog, abtHome } from "../log/store.ts";
import { DirTrees, MemoryTrees } from "../trees.ts";
import { loadGlobalConfig } from "./config.ts";
import { Runner, type RunnerProject } from "./daemon.ts";
import { DispatchStore } from "./dispatch-store.ts";
import { LaunchdAgent, systemLaunchctl } from "./launchd.ts";
import { LockError, processAlive, runnerStatus } from "./lock.ts";
import { sendNudge } from "./socket.ts";
import { ProcessWorkers } from "./workers.ts";

const USAGE = `usage: abt runner <command>

commands:
  start             install and load the launchd agent
  stop              unload the launchd agent
  status            show whether the runner is running (exit 0) or not (exit 3)
  nudge <ticket>    ask the running runner for a pass on a ticket
  run [--world f]   run the daemon in the foreground (what launchd runs)
`;

export async function runnerCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const home = abtHome();
  switch (sub) {
    case "start":
    case "stop": {
      const agent = new LaunchdAgent({
        launchctl: systemLaunchctl,
        plistDir: join(homedir(), "Library", "LaunchAgents"),
        uid: process.getuid?.() ?? 0,
        home,
        program: [process.execPath, "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../cli.ts", import.meta.url)), "runner", "run"],
      });
      try {
        await (sub === "start" ? agent.start() : agent.stop());
      } catch (e) {
        console.error(`abt: ${(e as Error).message}`);
        return 1;
      }
      console.log(sub === "start" ? "runner started" : "runner stopped");
      return 0;
    }
    case "status": {
      const s = runnerStatus({ dir: home, clock: systemClock, isAlive: processAlive });
      const beat = s.heartbeatAgeMs === undefined ? "no heartbeat" : `heartbeat ${Math.round(s.heartbeatAgeMs / 1000)}s ago`;
      console.log(s.state === "stopped" ? "runner stopped" : `runner ${s.state} (pid ${s.pid}, ${beat})`);
      return s.state === "running" ? 0 : 3;
    }
    case "nudge": {
      const ticket = rest[0];
      if (!ticket) {
        console.error("usage: abt runner nudge <ticket>");
        return 2;
      }
      try {
        const answer = await sendNudge(join(home, "runner.sock"), ticket);
        console.log(answer);
        return answer === "ok" ? 0 : 1;
      } catch (e) {
        console.error(`abt: cannot reach the runner: ${(e as NodeJS.ErrnoException).code ?? e}`);
        return 1;
      }
    }
    case "run":
      return runDaemon(home, rest);
    default:
      console.error(USAGE.trimEnd());
      return 2;
  }
}

async function runDaemon(home: string, flags: string[]): Promise<number> {
  const w = flags.indexOf("--world");
  const worldFile = w >= 0 ? flags[w + 1] : undefined;
  const newId = randomUUID;
  const log = new DecisionLog(home, systemClock, newId);
  const plugin = new DirTrees(fileURLToPath(new URL("../../defaults/trees/", import.meta.url)));
  let projects: RunnerProject[];
  if (worldFile) {
    const world = await loadFakeWorld(worldFile);
    const { tracker, codeHost, harness, workspace } = world;
    projects = [{ name: "fake", tracker, log, deps: (ticket) => ({ ticket, tracker, codeHost, harness, workspace, log, newId, plugin, project: new MemoryTrees(".agents/abt/trees", {}) }) }];
  } else {
    // Real code host and harness adapters are not built yet, so a listed project cannot be served.
    // Say so and keep running (launchd would only restart a daemon that exits), heartbeat and all.
    for (const p of loadGlobalConfig(home).projects) {
      console.error(`abt runner: project "${p.name}" skipped: real code host and harness adapters are not wired yet`);
    }
    projects = [];
  }
  const runner = new Runner({
    home, clock: systemClock, timers: systemTimers, pid: process.pid, isAlive: processAlive, projects,
    workers: new ProcessWorkers(), newId, store: new DispatchStore(join(home, "dispatch.json")), socketPath: join(home, "runner.sock"),
  });
  try {
    await runner.start();
  } catch (e) {
    if (e instanceof LockError) {
      console.error(`abt: ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.log(`abt runner: serving ${projects.length} project(s)`);
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => resolve());
  });
  await runner.stop();
  return 0;
}
