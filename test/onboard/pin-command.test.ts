import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardCommand } from "../../src/onboard/cli.ts";

/** A project directory that does not exist: a refusal must come before any git or gh call. */
const args = ["pin", "--project", "/nonexistent/abt-project"];

async function run(io: Parameters<typeof onboardCommand>[1]) {
  const errors: string[] = [];
  const spy = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    return { code: await onboardCommand(args, io), errors };
  } finally {
    console.error = spy;
  }
}

test("a worker cannot re-pin, even from a terminal", async () => {
  const r = await run({ env: { ABT_ROLE: "worker" }, interactive: true, confirm: async () => "acme__demo" });
  assert.equal(r.code, 1);
  assert.match(r.errors.join("\n"), /only the owner/);
});

test("re-pinning needs the owner at a terminal: a headless run cannot", async () => {
  const r = await run({ env: {}, interactive: false, confirm: async () => "acme__demo" });
  assert.equal(r.code, 1);
  assert.match(r.errors.join("\n"), /terminal/);
});
