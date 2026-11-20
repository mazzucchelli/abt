import { readFileSync } from "node:fs";
import { FakeClock } from "./clock.ts";
import { FakeCodeHost } from "./codehost/fake.ts";
import type { CodeHostFacts } from "./codehost/contract.ts";
import { FakeHarness, type ScriptedOutcome } from "./harness/fake.ts";
import type { LifecycleState } from "./tracker/contract.ts";
import { InMemoryTracker } from "./tracker/fake.ts";
import { FakeWorkspace } from "./workspace/fake.ts";

/**
 * A fake world described in JSON, for `abt run --world`. Tickets are created in order as
 * FAKE-1, FAKE-2, ... The file is read, never written: each pass starts from this world.
 */
export interface WorldFile {
  now?: string;
  tickets?: { title: string; body?: string; state?: LifecycleState }[];
  codeHost?: Record<string, Partial<CodeHostFacts>>;
  harness?: Record<string, ScriptedOutcome[]>;
}

export interface FakeWorld {
  tracker: InMemoryTracker;
  codeHost: FakeCodeHost;
  harness: FakeHarness;
  workspace: FakeWorkspace;
  clock: FakeClock;
}

export async function loadFakeWorld(path: string): Promise<FakeWorld> {
  const file = JSON.parse(readFileSync(path, "utf8")) as WorldFile;
  const tracker = new InMemoryTracker();
  for (const t of file.tickets ?? []) {
    const created = await tracker.createTicket({ title: t.title, body: t.body ?? "" });
    if (t.state) await tracker.setState(created.id, t.state);
  }
  const codeHost = new FakeCodeHost();
  for (const [ticket, facts] of Object.entries(file.codeHost ?? {})) codeHost.setFacts(ticket, facts);
  const harness = new FakeHarness();
  for (const [agent, outcomes] of Object.entries(file.harness ?? {})) harness.script(agent, ...outcomes);
  return { tracker, codeHost, harness, workspace: new FakeWorkspace(), clock: new FakeClock(file.now) };
}
