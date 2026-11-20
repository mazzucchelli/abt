import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdapterDoc, parseAdapterDoc } from "../../src/tracker/config.ts";
import { resolveCredential } from "../../src/tracker/credentials.ts";
import { createLinearTracker } from "../../src/tracker/linear.ts";
import { decodeComment, encodeComment } from "../../src/tracker/contract.ts";
import { contractSuite } from "./contract-suite.ts";

// Real run: ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=<path to a sandbox adapter doc> plus its credential.
// The sandbox team must already have the mapped states and labels. It creates tickets there.
const live = process.env.ABT_TEST_LINEAR === "1";
const adapter = process.env.ABT_TEST_LINEAR_ADAPTER;

contractSuite(
  "linear sandbox",
  async () => {
    const config = loadAdapterDoc(adapter!).tracker;
    return createLinearTracker(config, { apiKey: resolveCredential(config.credentials) });
  },
  { skip: !live || !adapter ? "set ABT_TEST_LINEAR=1 and ABT_TEST_LINEAR_ADAPTER to run against a sandbox team" : false },
);

const config = parseAdapterDoc(`---
tracker:
  kind: linear
  team: ABT
  credentials: { env: LINEAR_API_KEY }
  states:
    Todo: Todo
    In progress: In Progress
    In review: In Review
    Needs you: Needs You
    Done: Done
    Abandoned: Canceled
---
`).tracker;

const setupResponse = (stateNames: string[], labelNames: string[]) => async () =>
  new Response(
    JSON.stringify({
      data: {
        team: { id: "t1", states: { nodes: stateNames.map((name) => ({ id: name, name })) } },
        issueLabels: { nodes: labelNames.map((name) => ({ id: name, name })) },
      },
    }),
  );

const allStates = ["Todo", "In Progress", "In Review", "Needs You", "Done", "Canceled"];
const allLabels = ["abt", "implement", "research", "spike", "bootstrap", "risk:low", "risk:medium", "risk:high"];

test("linear: a mapped state missing from the team stops startup with a clear error", async () => {
  await assert.rejects(
    createLinearTracker(config, { apiKey: "k", fetch: setupResponse(allStates.filter((s) => s !== "Needs You"), allLabels) as typeof fetch }),
    /does not have: Needs you -> "Needs You"/,
  );
});

test("linear: a mapped label missing from Linear stops startup with a clear error", async () => {
  await assert.rejects(
    createLinearTracker(config, { apiKey: "k", fetch: setupResponse(allStates, allLabels.filter((l) => l !== "risk:high")) as typeof fetch }),
    /missing labels.*"risk:high"/,
  );
});

test("linear: sends the API key as the authorization header, never in the body", async () => {
  let seen: RequestInit | undefined;
  await createLinearTracker(config, {
    apiKey: "secret-key",
    fetch: (async (_url: unknown, init: RequestInit) => {
      seen = init;
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  assert.equal((seen!.headers as Record<string, string>).authorization, "secret-key");
  assert.ok(!String(seen!.body).includes("secret-key"));
});

test("comment encoding rejects kinds it could not decode and keeps trailing newlines", () => {
  assert.throws(() => encodeComment({ kind: "needs you", body: "x" }), /kind/);
  assert.throws(() => encodeComment({ kind: "a-->b", body: "x" }), /kind/);
  const c = { kind: "note", body: "ends with newline\n", data: {} };
  assert.deepEqual(decodeComment(encodeComment(c)), c);
});

test("linear: labels are looked up only in the team and the workspace", async () => {
  let query = "";
  let variables: Record<string, unknown> = {};
  await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      ({ query, variables } = JSON.parse(String(init.body)));
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  assert.match(query, /issueLabels\(.*filter/s);
  assert.equal(variables.team, "ABT");
});

test("comment encoding round-trips and ignores comments abt did not write", () => {
  const c = { kind: "decision", body: "line one\n\nline two", data: { a: [1, "é"] } };
  assert.deepEqual(decodeComment(encodeComment(c)), c);
  assert.equal(decodeComment("just a human comment"), undefined);
});

test("credentials resolve from env or Keychain and fail loudly when absent", () => {
  const sources = { env: { LINEAR_API_KEY: "k1" }, keychain: (i: string) => (i === "abt" ? "k2" : undefined) };
  assert.equal(resolveCredential({ env: "LINEAR_API_KEY" }, sources), "k1");
  assert.equal(resolveCredential({ keychain: "abt" }, sources), "k2");
  assert.throws(() => resolveCredential({ env: "NOPE" }, sources), /environment variable NOPE/);
  assert.throws(() => resolveCredential({ keychain: "nope" }, sources), /Keychain item "nope"/);
});

test("linear: setRisk adds the tier label and removes the other tier labels, touching nothing else", async () => {
  let update: { id: string; input: Record<string, unknown> } | undefined;
  const tracker = await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      if (/issueUpdate/.test(query)) {
        update = variables;
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
      }
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  await tracker.setRisk("ABT-1", "high");
  assert.equal(update!.id, "ABT-1");
  assert.deepEqual(update!.input, { addedLabelIds: ["risk:high"], removedLabelIds: ["risk:low", "risk:medium"] });
});
