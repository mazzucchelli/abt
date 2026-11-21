import { readFileSync } from "node:fs";
import { MemoryPolicy } from "../../src/landing/policy.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

const policy = new MemoryPolicy(readFileSync(new URL("../../docs/examples/merge-policy.yaml", import.meta.url), "utf8"));

/** A fresh in-memory tracker, an agreed policy and a runner that answers every nudge. */
export function world() {
  const tracker = new InMemoryTracker();
  const nudges: string[] = [];
  const deps = {
    tracker,
    policy,
    nudge: async (ticket: string) => {
      nudges.push(ticket);
      return "ok";
    },
  };
  return { tracker, deps, nudges };
}
