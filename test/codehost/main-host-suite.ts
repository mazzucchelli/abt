import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobResult, MainHost } from "../../src/codehost/contract.ts";

/** What the suite needs from a world besides the host: a commit on the default branch, CI on it, and a look at the revert PRs. */
export interface MainHostWorld {
  host: MainHost;
  /** Lands a new commit on the default branch and resolves to its SHA. */
  commit(): Promise<string>;
  /** Makes a CI job report on a commit. */
  report(sha: string, job: string, state: JobResult["state"]): Promise<void>;
  /** The revert PRs the world has for a commit, whatever their state. */
  reverts(sha: string): Promise<{ url: string; merged: boolean }[]>;
  cleanup?(): Promise<void>;
}

/** One suite, run against every MainHost so the fake cannot drift from reality. */
export function mainHostContractSuite(name: string, make: () => Promise<MainHostWorld> | MainHostWorld, opts: { skip?: string | false } = {}): void {
  const t = (title: string, fn: (w: MainHostWorld) => Promise<void>) =>
    test(`${name}: ${title}`, { skip: opts.skip || false, timeout: 120_000 }, async () => {
      const w = await make();
      try {
        await fn(w);
      } finally {
        await w.cleanup?.();
      }
    });

  t("mainJobs has no entry for a job that has not reported", async ({ host, commit, report }) => {
    const sha = await commit();
    assert.deepEqual(await host.mainJobs(sha), {});
    await report(sha, "test", "success");
    assert.deepEqual(Object.keys(await host.mainJobs(sha)), ["test"]);
  });

  t("mainJobs reports each job by name with its state, for the commit asked about", async ({ host, commit, report }) => {
    const sha = await commit();
    const other = await commit();
    await report(sha, "test", "success");
    await report(sha, "lint", "failure");
    await report(sha, "e2e", "pending");
    assert.deepEqual(await host.mainJobs(sha), {
      test: { state: "success", sha },
      lint: { state: "failure", sha },
      e2e: { state: "pending", sha },
    });
    assert.deepEqual(await host.mainJobs(other), {});
  });

  t("openRevertPr returns a PR URL, leaves it unmerged, and a second call for the same commit opens no second PR", async ({ host, commit, reverts }) => {
    const sha = await commit();
    const url = await host.openRevertPr(sha, { title: `Revert ${sha}`, body: "CI is red" });
    assert.match(url, /^https?:\/\//);
    assert.equal(await host.openRevertPr(sha, { title: `Revert ${sha}`, body: "CI is red" }), url);
    assert.deepEqual(await reverts(sha), [{ url, merged: false }]);
  });

  t("each commit gets its own revert PR", async ({ host, commit, reverts }) => {
    const a = await commit();
    const b = await commit();
    const urlA = await host.openRevertPr(a, { title: "Revert a", body: "" });
    const urlB = await host.openRevertPr(b, { title: "Revert b", body: "" });
    assert.notEqual(urlA, urlB);
    assert.equal((await reverts(a)).length, 1);
    assert.equal((await reverts(b)).length, 1);
  });
}
