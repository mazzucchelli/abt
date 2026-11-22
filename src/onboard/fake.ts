import { FakeOnboardHost } from "./fake-host.ts";
import { acceptPins, MemoryPins } from "./pins.ts";
import { missingFacts, type FactsProbe, type ProjectFacts } from "./facts.ts";

/** A probe that answers with the facts and files it was given. */
export class FakeProbe implements FactsProbe {
  readonly #facts: ProjectFacts;
  readonly #files: string[];
  constructor(facts: ProjectFacts, files: string[]) {
    this.#facts = facts;
    this.#files = files;
  }
  async facts() {
    return structuredClone(this.#facts);
  }
  /** Someone changing the project on the code host: these facts now read differently. */
  change(patch: Partial<ProjectFacts>): void {
    Object.assign(this.#facts, patch);
  }
  async files() {
    return [...this.#files];
  }
}

/** A solo, private repo with no server-side protection and a `can-merge` aggregator job: everything known. */
export function soloPrivateFacts(): ProjectFacts {
  const f: ProjectFacts = {
    id: "me__solo",
    default_branch: "main",
    visibility: "private",
    plan: "free",
    protection: { enforced: false, required_checks: [], approvals: 0 },
    allow_auto_merge: false,
    merge_queue_available: false,
    write_collaborators: ["me"],
    write_apps: [],
    ci: { jobs: ["test", "build", "typecheck", "can-merge"], aggregator: "can-merge" },
    test_tooling: ["node --test"],
    preview_deployments: false,
  };
  if (missingFacts(f).length > 0) throw new Error("soloPrivateFacts must be complete");
  return f;
}

/** A project whose abt files are pinned as they stand: what a merged onboarding PR leaves behind. */
export async function pinnedProject(project: string, main: Record<string, string> = {}): Promise<{ files: FakeOnboardHost; store: MemoryPins; project: string }> {
  const files = new FakeOnboardHost(main);
  const store = new MemoryPins();
  await acceptPins({ files, pins: store, project });
  return { files, store, project };
}
