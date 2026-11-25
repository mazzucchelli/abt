import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSetup, setupTracker } from "../../src/onboard/tracker-setup.ts";
import { parseAdapterDoc } from "../../src/tracker/config.ts";
import { adapterDoc } from "../../src/onboard/bundle.ts";

const { states, labels } = parseAdapterDoc(adapterDoc({ team: "ABT", credentials: { keychain: "abt-linear" } })).tracker;

/** A fake Linear: answers the lookup query from `team`, records every mutation. */
function fakeLinear(team: { states: string[]; labels: string[] } | undefined) {
  const mutations: { query: string; input: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const data = query.includes("mutation")
      ? (mutations.push({ query, input: variables.input }), { ok: { success: true } })
      : {
          teams: { nodes: team ? [{ id: "t1", states: { nodes: team.states.map((name) => ({ name })) } }] : [] },
          issueLabels: { nodes: (team?.labels ?? []).map((name) => ({ name })) },
        };
    return new Response(JSON.stringify({ data }));
  }) as typeof fetch;
  return { fetchFn, mutations };
}

const DEFAULT_LINEAR_STATES = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"];

test("setup: a fresh team gets the Needs You state and every abt label", async () => {
  const { fetchFn, mutations } = fakeLinear({ states: DEFAULT_LINEAR_STATES, labels: [] });
  const r = await setupTracker({ apiKey: "k", team: "ABT", states, labels, fetch: fetchFn });
  assert.deepEqual(r.createdStates, ["Needs You"]);
  assert.deepEqual(r.createdLabels, ["abt", "implement", "research", "spike", "bootstrap", "risk:low", "risk:medium", "risk:high"]);
  const state = mutations.find((m) => m.query.includes("workflowStateCreate"))!;
  assert.deepEqual(state.input, { teamId: "t1", name: "Needs You", type: "started", color: "#F2C94C" });
  assert.equal(mutations.length, 9);
});

test("setup: running it again creates nothing", async () => {
  const { fetchFn, mutations } = fakeLinear({
    states: [...DEFAULT_LINEAR_STATES, "Needs You"],
    labels: ["abt", "implement", "research", "spike", "bootstrap", "risk:low", "risk:medium", "risk:high"],
  });
  const r = await setupTracker({ apiKey: "k", team: "ABT", states, labels, fetch: fetchFn });
  assert.deepEqual([r.createdStates, r.createdLabels, mutations], [[], [], []]);
  assert.match(describeSetup("ABT", r), /states: all there\n {2}labels: all there/);
});

test("setup: Backlog and Duplicate are never created", async () => {
  const { fetchFn, mutations } = fakeLinear({ states: ["Todo", "In Progress", "In Review", "Done", "Canceled"], labels: [] });
  const r = await setupTracker({ apiKey: "k", team: "ABT", states, labels, fetch: fetchFn });
  assert.deepEqual(r.createdStates, ["Needs You"]);
  assert.ok(!mutations.some((m) => ["Backlog", "Duplicate"].includes(String(m.input.name))));
});

test("setup: a team that does not exist is a clear error, not a created team", async () => {
  const { fetchFn, mutations } = fakeLinear(undefined);
  await assert.rejects(setupTracker({ apiKey: "k", team: "ABT", states, labels, fetch: fetchFn }), /no team with the key "ABT": create the team in Linear first/);
  assert.equal(mutations.length, 0);
});
