import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const abt = (...args: string[]) =>
  spawnSync("bin/abt", args, { encoding: "utf8" });

test("abt validate exits 0 on a valid tree", () => {
  const r = abt("validate", "test/fixtures/valid.yaml");
  assert.equal(r.status, 0);
});

test("abt validate exits non-zero and prints file:line:col diagnostics on an invalid tree", () => {
  const r = abt("validate", "test/fixtures/invalid.yaml");
  assert.notEqual(r.status, 0);
  assert.equal(
    r.stderr.trim(),
    'test/fixtures/invalid.yaml:1:8 unknown check "branch-up-to-dat" (did you mean "branch-up-to-date"? known: branch-up-to-date, required-checks-green, diff-size, trees-valid, feedback-check)',
  );
});

test("abt validate exits non-zero when the file is missing", () => {
  const r = abt("validate", "test/fixtures/nope.yaml");
  assert.notEqual(r.status, 0);
});

for (const sub of ["run", "log", "onboard", "upgrade"]) {
  test(`abt ${sub} is a stub that exits non-zero`, () => {
    const r = abt(sub);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not implemented/);
  });
}

test("abt with an unknown subcommand prints usage and fails", () => {
  const r = abt("bogus");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: abt/);
});
