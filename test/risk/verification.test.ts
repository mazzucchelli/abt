import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { policyProblems } from "../../src/landing/policy.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { assessTicket } from "../../src/risk/assess.ts";
import type { CoverageInput } from "../../src/risk/coverage.ts";
import { parseRiskMap } from "../../src/risk/rules.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

async function world() {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: tweak tax", body: "Tweak the tax maths." });
  let n = 0;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-verif-")), new FakeClock(), () => `id-${++n}`);
  const coverage = (files: CoverageInput["files"], extra: Partial<CoverageInput> = {}): CoverageInput => ({
    files,
    main: ["src/tax.ts", "test/tax.test.ts", "src/vat.ts", "package-lock.json"],
    requiredRuns: ["test/**/*.test.ts"],
    green: { build: true, typecheck: true, canMerge: true, staticChecks: true },
    ...extra,
  });
  const assess = (files: CoverageInput["files"], extra: { map?: ReturnType<typeof parseRiskMap>; cov?: Partial<CoverageInput> } = {}) =>
    assessTicket({ log, tracker, ...(extra.map && { map: extra.map }) }, {
      ticket: id, run: "run-1", moment: "landing",
      diff: { files: files.map((f) => ({ path: f.path, added: 3, removed: 1 })) },
      coverage: coverage(files, extra.cov),
    });
  return { id, tracker, log, assess };
}

test("a backend change with a sibling test on main stays eligible for low", async () => {
  const w = await world();
  const a = await w.assess([{ path: "src/tax.ts", status: "modified" }]);
  assert.equal(a.tier, "low");
  assert.equal((await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap").length, 0);
});

test("the same change with its test added in the PR is capped at medium and files one bootstrap ticket", async () => {
  const w = await world();
  const files = [{ path: "src/vat.ts", status: "modified" as const }, { path: "test/vat.test.ts", status: "added" as const }];
  const a = await w.assess(files);
  assert.equal(a.tier, "medium");
  assert.ok(a.reasons.some((r) => r.includes("evidence gap") && r.includes("added in this PR")));
  await w.assess(files);
  const boot = (await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap");
  assert.equal(boot.length, 1);
  assert.equal(boot[0]!.risk, "medium");
  assert.match(boot[0]!.body, /src\/vat\.ts/);
});

test("a lockfile-only change is never low, even if the risk map tries to allow it", async () => {
  const w = await world();
  const map = parseRiskMap({ rules: [{ glob: "package-lock.json", tier: "low" }] });
  const a = await w.assess([{ path: "package-lock.json", status: "modified" }], { map });
  assert.notEqual(a.tier, "low");
});

const policy = (rules: string) => `version: 1
gates: { required_checks: [can-merge], approvals: 1 }
enforcement: server
risk_cap: low
mode: merge
risk_map:
  rules: ${rules}
facts: { default_branch: main }
land_tree_hash: ${"a".repeat(64)}
`;

test("a merge policy that loosens a fixed rule fails validation; tightening passes", () => {
  assert.deepEqual(policyProblems(policy("[]")), []);
  assert.deepEqual(policyProblems(policy('[{ glob: "src/billing/**", tier: high, reason: "money" }]')), []);
  assert.deepEqual(policyProblems(policy('[{ glob: "db/migrations/**", tier: medium, reason: "careful" }, { glob: "**", tier: medium, reason: "all" }]')), []);
  for (const glob of ["package-lock.json", "**/package.json", ".github/workflows/*.yml", "db/migrations/**", "tsconfig.json", "src/**", "apps/web/**", "**"]) {
    const problems = policyProblems(policy(`[{ glob: "${glob}", tier: low, reason: "fine" }]`));
    assert.ok(problems.some((p) => p.includes("loosen")), `${glob}: ${problems.join("; ")}`);
  }
});

test("touching one more uncovered file later does not refile the first gap", async () => {
  const w = await world();
  await w.assess([{ path: "src/vat.ts", status: "modified" }]);
  await w.assess([{ path: "src/vat.ts", status: "modified" }, { path: "src/fee.ts", status: "modified" }]);
  const boot = (await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap");
  assert.equal(boot.length, 2);
  assert.doesNotMatch(boot[1]!.body, /src\/vat\.ts/);
});
