import { test } from "node:test";
import assert from "node:assert/strict";
import { AdapterConfigError, parseAdapterDoc } from "../../src/tracker/config.ts";

const STATES = `
    Todo: Todo
    In progress: In Progress
    In review: In Review
    Needs you: Needs You
    Done: Done
    Abandoned: Canceled`;

const doc = (tracker: string) => `---\ntracker:\n${tracker}\n---\n\n# Workflow\n\nProse is ignored.\n`;

const valid = `  kind: linear
  team: ABT
  credentials:
    env: LINEAR_API_KEY
  states:${STATES}`;

test("parses front matter into a typed config with default labels", () => {
  const config = parseAdapterDoc(doc(valid));
  assert.equal(config.tracker.kind, "linear");
  assert.equal(config.tracker.team, "ABT");
  assert.deepEqual(config.tracker.credentials, { env: "LINEAR_API_KEY" });
  assert.equal(config.tracker.states["In progress"], "In Progress");
  assert.equal(config.tracker.states.Abandoned, "Canceled");
  assert.equal(config.tracker.labels.abt, "abt");
  assert.equal(config.tracker.labels.workType.spike, "spike");
  assert.equal(config.tracker.labels.risk.high, "risk:high");
});

test("accepts a Keychain credential and label overrides", () => {
  const config = parseAdapterDoc(
    doc(`${valid.replace("env: LINEAR_API_KEY", "keychain: abt-linear")}
  labels:
    abt: agent
    risk:
      high: danger`),
  );
  assert.deepEqual(config.tracker.credentials, { keychain: "abt-linear" });
  assert.equal(config.tracker.labels.abt, "agent");
  assert.equal(config.tracker.labels.risk.high, "danger");
  assert.equal(config.tracker.labels.risk.low, "risk:low");
});

test("an unmapped lifecycle state is a clear error", () => {
  const source = doc(valid.replace("\n    Needs you: Needs You", ""));
  assert.throws(
    () => parseAdapterDoc(source),
    (e) => e instanceof AdapterConfigError && /lifecycle state "Needs you" is not mapped/.test(e.message),
  );
});

test("rejects credentials that are not an env var or Keychain name", () => {
  for (const creds of [
    "    token: lin_api_abc123",
    "    env: lin_api_abc123",
    "    env: LINEAR_API_KEY\n    keychain: abt",
    "    env: ''",
  ]) {
    const source = doc(valid.replace("    env: LINEAR_API_KEY", creds));
    assert.throws(() => parseAdapterDoc(source), AdapterConfigError, creds);
  }
});

test("rejects missing front matter and unsupported trackers", () => {
  assert.throws(() => parseAdapterDoc("# no front matter"), /front matter/);
  assert.throws(() => parseAdapterDoc(doc(valid.replace("linear", "github"))), /unsupported tracker "github"/);
});

test("rejects two lifecycle states mapped to the same tracker state", () => {
  const source = doc(valid.replace("Needs you: Needs You", "Needs you: In Review"));
  assert.throws(() => parseAdapterDoc(source), /"In Review" is mapped to both "In review" and "Needs you"/);
});
