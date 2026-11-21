import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/primary/cli.ts";

test("flags are pulled out wherever they sit", () => {
  const p = parseArgs(["ABT-1", "--type", "spike", "ABT-2", "--exploratory"]);
  assert.deepEqual(p, { flags: { "--type": "spike" }, exploratory: true, words: ["ABT-1", "ABT-2"] });
});

test("everything after -- is text, even when it looks like a flag", () => {
  const p = parseArgs(["--entry", "research", "--", "Add", "a", "--type", "flag", "--exploratory"]);
  assert.deepEqual(p, { flags: { "--entry": "research" }, exploratory: false, words: ["Add", "a", "--type", "flag", "--exploratory"] });
});

test("a flag with no value is a usage error", () => {
  assert.equal(parseArgs(["ABT-1", "--type"]), undefined);
});
