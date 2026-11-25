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

/** A fake Linear that tracks one issue's labels and, like the real one, refuses to remove a label the issue lacks. */
const labelledIssue = (initial: string[]) => {
  const labels = new Set(initial);
  const updates: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    if (/issueUpdate/.test(query)) {
      const { addedLabelIds = [], removedLabelIds = [] } = variables.input as { addedLabelIds?: string[]; removedLabelIds?: string[] };
      updates.push(variables.input);
      for (const l of removedLabelIds) {
        if (!labels.has(l)) return new Response(JSON.stringify({ errors: [{ message: "Label not on issue" }] }));
        labels.delete(l);
      }
      for (const l of addedLabelIds) labels.add(l);
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }
    if (/issue\(id/.test(query)) {
      const issue = {
        identifier: "ABT-1",
        title: "t",
        description: null,
        state: { name: "Todo" },
        assignee: null,
        labels: { nodes: [...labels].map((name) => ({ name })) },
        attachments: { nodes: [] },
      };
      return new Response(JSON.stringify({ data: { issue } }));
    }
    return setupResponse(allStates, allLabels)();
  }) as typeof fetch;
  return { labels, updates, fetch: fetchImpl };
};

test("linear: setRisk adds the tier label and removes only the other tier labels the ticket has", async () => {
  const linear = labelledIssue(["abt", "risk:low", "risk:medium"]);
  const tracker = await createLinearTracker(config, { apiKey: "k", fetch: linear.fetch });
  await tracker.setRisk("ABT-1", "high");
  assert.deepEqual(linear.updates, [{ addedLabelIds: ["risk:high"], removedLabelIds: ["risk:low", "risk:medium"] }]);
  assert.deepEqual([...linear.labels].sort(), ["abt", "risk:high"]);
});

test("linear: setRisk on a ticket with no risk label removes nothing", async () => {
  const linear = labelledIssue(["abt"]);
  const tracker = await createLinearTracker(config, { apiKey: "k", fetch: linear.fetch });
  await tracker.setRisk("ABT-1", "high");
  assert.deepEqual(linear.updates, [{ addedLabelIds: ["risk:high"], removedLabelIds: [] }]);
});

test("linear: a comment abt did not write is read back as a reply by its author, and the ticket names its owner and url", async () => {
  const { encodeComment } = await import("../../src/tracker/contract.ts");
  const tracker = await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("issueLabels")) return setupResponse(allStates, allLabels)();
      if (query.includes("comments(")) {
        return new Response(JSON.stringify({ data: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          { id: "c2", body: "yes", createdAt: "2026-01-02T00:00:00Z", user: { id: "u-owner" } },
          { id: "c1", body: encodeComment({ kind: "ask-point", body: "Q?", data: { n: 1 } }), createdAt: "2026-01-01T00:00:00Z", user: { id: "u-bot" } },
        ] } } } }));
      }
      return new Response(JSON.stringify({ data: { issue: {
        identifier: "ABT-1", title: "t", description: null, state: { name: "Needs You" }, assignee: null, creator: { id: "u-owner" },
        url: "https://linear.app/x/issue/ABT-1", labels: { nodes: [] }, attachments: { nodes: [] },
      } } }));
    }) as typeof fetch,
  });
  const t = await tracker.readTicket("ABT-1");
  assert.equal(t.owner, "u-owner");
  assert.equal(t.url, "https://linear.app/x/issue/ABT-1");
  const comments = (await tracker.readCommentsSince("ABT-1")).comments;
  assert.deepEqual(comments.map((c) => [c.id, c.kind, c.author]), [["c1", "ask-point", undefined], ["c2", "reply", "u-owner"]]);
});

test("linear: enqueue adds the abt marker and the work type and removes only the other work types the ticket has", async () => {
  const linear = labelledIssue(["abt", "implement", "spike"]);
  const tracker = await createLinearTracker(config, { apiKey: "k", fetch: linear.fetch });
  await tracker.enqueue("ABT-1", "research");
  assert.deepEqual(linear.updates, [{ addedLabelIds: ["abt", "research"], removedLabelIds: ["implement", "spike"] }]);
  assert.deepEqual([...linear.labels].sort(), ["abt", "research"]);
});

test("linear: enqueue on a fresh ticket that carries none of the other work types removes nothing", async () => {
  const linear = labelledIssue(["abt", "implement"]);
  const tracker = await createLinearTracker(config, { apiKey: "k", fetch: linear.fetch });
  await tracker.enqueue("ABT-1", "implement");
  assert.deepEqual(linear.updates, [{ addedLabelIds: ["abt", "implement"], removedLabelIds: [] }]);
});

test("linear: addBlocker creates a blocks relation from the blocker to the ticket", async () => {
  let input: Record<string, unknown> | undefined;
  const tracker = await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      if (/issueRelationCreate/.test(query)) {
        input = variables.input;
        return new Response(JSON.stringify({ data: { issueRelationCreate: { success: true } } }));
      }
      if (/issue\(id/.test(query)) {
        const issue = { identifier: "ABT-2", title: "t", description: null, state: { name: "Todo" }, assignee: null, labels: { nodes: [] }, attachments: { nodes: [] } };
        return new Response(JSON.stringify({ data: { issue } }));
      }
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  await tracker.addBlocker("ABT-2", "ABT-1");
  assert.deepEqual(input, { issueId: "ABT-1", relatedIssueId: "ABT-2", type: "blocks" });
});

test("linear: addBlocker does nothing when the blocker already blocks the ticket", async () => {
  let created = 0;
  const tracker = await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (/issueRelationCreate/.test(query)) {
        created++;
        return new Response(JSON.stringify({ data: { issueRelationCreate: { success: true } } }));
      }
      if (/issue\(id/.test(query)) {
        const issue = {
          identifier: "ABT-2", title: "t", description: null, state: { name: "Todo" }, assignee: null,
          labels: { nodes: [] }, attachments: { nodes: [] },
          inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ABT-1" } }] },
        };
        return new Response(JSON.stringify({ data: { issue } }));
      }
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  await tracker.addBlocker("ABT-2", "ABT-1");
  assert.equal(created, 0);
});

test("linear: postReply is a plain comment with no abt marker", async () => {
  let input: { issueId: string; body: string } | undefined;
  const tracker = await createLinearTracker(config, {
    apiKey: "k",
    fetch: (async (_u: unknown, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      if (/commentCreate/.test(query)) {
        input = variables.input;
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }));
      }
      return setupResponse(allStates, allLabels)();
    }) as typeof fetch,
  });
  await tracker.postReply("ABT-1", "answer: use postgres");
  assert.deepEqual(input, { issueId: "ABT-1", body: "answer: use postgres" });
});

test("linear: a team without Backlog and Duplicate still starts, since abt never sets them", async () => {
  await createLinearTracker(config, { apiKey: "k", fetch: setupResponse(allStates, allLabels) as typeof fetch });
});
