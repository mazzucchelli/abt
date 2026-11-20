import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validate.ts";

const messages = (source: string) =>
  validate(source, "tree.yaml").map((d) => d.message);

test("accepts a tree using every node kind", () => {
  const source = `
id: root
seq:
  - check: branch-up-to-date
  - fallback:
      - check: required-checks-green
      - action: commit
      - agent: "Fix whatever is failing"
  - retry: 3
    do:
      action: run-tests
  - timeout: 30s
    do:
      agent: "Summarise the diff"
  - ensure:
      cond:
        all:
          - check: required-checks-green
          - not:
              judge: "Is the diff risky?"
          - any:
              - check: trees-valid
              - judge: "Is the file optional?"
      else:
        action: run-tests
  - use: shared-step
    with:
      target: main
`;
  assert.deepEqual(validate(source, "tree.yaml"), []);
});

test("reports an unknown check with a suggestion", () => {
  assert.deepEqual(messages("check: branch-up-to-dat\n"), [
    'tree.yaml:1:8 unknown check "branch-up-to-dat" (did you mean "branch-up-to-date"? known: branch-up-to-date, required-checks-green, diff-size, trees-valid, feedback-check)',
  ]);
});

test("rejects a non-condition in a condition slot", () => {
  const source = `
ensure:
  cond:
    action: run-tests
  else:
    action: run-tests
`;
  assert.deepEqual(messages(source), [
    'tree.yaml:4:5 "action" is not a condition (expected check, judge, all, any or not)',
  ]);
});

test("rejects a non-condition nested inside all/any/not", () => {
  assert.deepEqual(messages("all:\n  - check: branch-up-to-date\n  - agent: hi\n"), [
    'tree.yaml:3:5 "agent" is not a condition (expected check, judge, all, any or not)',
  ]);
  assert.deepEqual(messages("not:\n  action: x\n"), [
    'tree.yaml:2:3 "action" is not a condition (expected check, judge, all, any or not)',
  ]);
});

test("rejects a non-condition as the guard of a fallback", () => {
  assert.deepEqual(messages("fallback:\n  - action: x\n  - check: trees-valid\n"), [
    'tree.yaml:2:5 "action" is not a condition (expected check, judge, all, any or not)',
  ]);
});

test("rejects a bare string as a node", () => {
  assert.deepEqual(messages("seq:\n  - run-tests\n"), [
    'tree.yaml:2:5 bare string "run-tests" is not allowed here (use check:, judge:, action: or agent:)',
  ]);
});

test("rejects a bare string in a condition slot", () => {
  assert.deepEqual(messages("ensure:\n  cond: required-checks-green\n  else:\n    action: x\n"), [
    'tree.yaml:2:9 bare string "required-checks-green" is not allowed here (use check:, judge:, action: or agent:)',
  ]);
});

test("rejects unknown nodes and keys, and malformed YAML", () => {
  assert.deepEqual(messages("sequence:\n  - action: x\n"), ['tree.yaml:1:1 unknown node "sequence"']);
  assert.deepEqual(messages("action: x\nextra: 1\n"), ['tree.yaml:2:1 unknown key "extra"']);
  assert.equal(messages("seq: [\n").length > 0, true);
});

test("does not suggest when nothing is close", () => {
  assert.deepEqual(messages("check: zzzzzzzzzz\n"), ['tree.yaml:1:8 unknown check "zzzzzzzzzz" (known: branch-up-to-date, required-checks-green, diff-size, trees-valid, feedback-check)']);
});

test("every example tree under docs/ is valid", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = (readdirSync("docs", { recursive: true }) as string[])
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join("docs", f));
  assert.ok(files.length > 0, "expected at least one example under docs/");
  for (const file of files) {
    assert.deepEqual(validate(readFileSync(file, "utf8"), file), [], file);
  }
});
