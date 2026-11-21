import { test } from "node:test";
import assert from "node:assert/strict";
import { machine, until } from "../runner/machine.ts";

test("the runner's scan settles a pending onboarding, so a hand merge gets its pins without a command", async () => {
  let settled = 0;
  const m = machine({}, { project: { onboarding: { settle: async () => void settled++ } } });
  const r = m.runner();
  await r.start();
  await until(async () => settled >= 1);
  await r.stop();
});

test("an onboarding check that fails is logged and does not stop the scan", async () => {
  const m = machine({}, { project: { onboarding: { settle: async () => Promise.reject(new Error("gh down")) } } });
  const r = m.runner();
  await r.start();
  await until(async () => m.errors.some((e) => /onboarding for p: gh down/.test(e)));
  await r.stop();
});
