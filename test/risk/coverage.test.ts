import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCoverage, type ChangedFile, type CoverageInput } from "../../src/risk/coverage.ts";

const mod = (path: string): ChangedFile => ({ path, status: "modified" });
const add = (path: string): ChangedFile => ({ path, status: "added" });
const green = { build: true, typecheck: true, canMerge: true, staticChecks: true };

/** A project whose main has these files and whose required job runs every test under test/ and e2e/. */
function input(files: ChangedFile[], extra: Partial<CoverageInput> = {}): CoverageInput {
  return {
    files,
    main: ["src/pay/total.ts", "test/pay/total.test.ts", "src/pay/tax.ts", "e2e/cart.spec.ts", "README.md"],
    requiredRuns: ["test/**/*.test.ts", "e2e/**/*.spec.ts"],
    green,
    ...extra,
  };
}

test("a backend change with a sibling test on main run by a required job is covered and stays eligible for low", () => {
  const c = assessCoverage(input([mod("src/pay/total.ts")]));
  assert.deepEqual(c.gaps, []);
  assert.equal(c.lowEligible, true);
});

test("the same change with its test added in the PR is not covered", () => {
  const c = assessCoverage(input([mod("src/pay/tax.ts"), add("test/pay/tax.test.ts")]));
  assert.equal(c.lowEligible, false);
  assert.equal(c.gaps.length, 1);
  assert.match(c.gaps[0]!.reason, /added in this PR/);
  assert.equal(c.gaps[0]!.needsBootstrap, true);
});

test("a sibling test that no required job runs does not cover", () => {
  const c = assessCoverage(input([mod("src/pay/total.ts")], { requiredRuns: ["other/**"] }));
  assert.equal(c.lowEligible, false);
});

test("deleting or renaming the covering test voids its pairing", () => {
  const del = assessCoverage(input([mod("src/pay/total.ts"), { path: "test/pay/total.test.ts", status: "deleted" }]));
  assert.equal(del.lowEligible, false);
  const ren = assessCoverage(input([mod("src/pay/total.ts"), { path: "test/pay/sum.test.ts", status: "renamed", from: "test/pay/total.test.ts" }]));
  assert.equal(ren.lowEligible, false);
});

test("an explicit override in the risk map pairs a module with a check", () => {
  const c = assessCoverage(input([mod("src/pay/tax.ts")], { pairing: [{ glob: "src/pay/tax.ts", checks: ["test/pay/total.test.ts"] }] }));
  assert.equal(c.lowEligible, true);
});

test("backend logic also needs build, typecheck and can-merge green", () => {
  const c = assessCoverage(input([mod("src/pay/total.ts")], { green: { build: true, typecheck: false, canMerge: true, staticChecks: true } }));
  assert.equal(c.lowEligible, false);
  assert.equal(c.gaps[0]!.needsBootstrap, false);
  assert.match(c.gaps[0]!.reason, /typecheck/);
});

test("docs need only static checks", () => {
  assert.equal(assessCoverage(input([mod("README.md")])).lowEligible, true);
  assert.equal(assessCoverage(input([mod("README.md")], { green: { ...green, staticChecks: false } })).lowEligible, false);
});

test("UI needs an e2e spec on the touched route; a unit test does not count", () => {
  const files = [mod("app/cart/page.tsx")];
  assert.equal(assessCoverage(input(files)).lowEligible, true);
  const other = assessCoverage(input([mod("app/profile/page.tsx")], { main: ["app/profile/page.tsx", "test/app/profile/page.test.ts"] }));
  assert.equal(other.lowEligible, false);
  assert.equal(other.gaps[0]!.needsBootstrap, true);
});

test("a refactor keeps its covering tests unchanged", () => {
  const touched = assessCoverage(input([mod("src/pay/total.ts"), mod("test/pay/total.test.ts")], { refactor: true }));
  assert.equal(touched.lowEligible, false);
  assert.equal(assessCoverage(input([mod("src/pay/total.ts")], { refactor: true })).lowEligible, true);
});

test("a baseline update or visual diff is never low", () => {
  assert.equal(assessCoverage(input([mod("README.md"), mod("e2e/cart.spec.ts-snapshots/cart.png")])).lowEligible, false);
  assert.equal(assessCoverage(input([mod("README.md")], { visualDiff: true })).lowEligible, false);
});
