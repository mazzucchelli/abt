import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadMovedError, type CodeHost, type PrHost, type StatusState } from "../../src/codehost/contract.ts";

/** What the suite needs from a world besides the host itself: a way to make branches and move heads. */
export interface CodeHostWorld {
  host: CodeHost & PrHost;
  /** Makes the ticket's branch, one commit ahead of the default branch, and resolves to its head SHA. */
  branch(ticket: string): Promise<string>;
  /** Pushes one more commit to the ticket's branch and resolves to the new head SHA. */
  advance(ticket: string): Promise<string>;
  /** The state of a commit status context on a commit, as the code host reports it. */
  statusOf(sha: string, context: string): Promise<StatusState | undefined>;
  cleanup?(): Promise<void>;
}

/**
 * One suite, run against every CodeHost so the fake cannot drift from reality.
 * `make` returns a world whose repository is safe to write to (the fake, or a sandbox).
 */
export function codeHostContractSuite(name: string, make: () => Promise<CodeHostWorld> | CodeHostWorld, opts: { skip?: string | false } = {}): void {
  const t = (title: string, fn: (w: CodeHostWorld, ticket: string) => Promise<void>) =>
    test(`${name}: ${title}`, { skip: opts.skip || false, timeout: 120_000 }, async () => {
      const w = await make();
      try {
        await fn(w, `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      } finally {
        await w.cleanup?.();
      }
    });

  t("a ticket with no PR has no pr and is not merged", async ({ host }, ticket) => {
    const facts = await host.readFacts(ticket);
    assert.equal(facts.pr, undefined);
    assert.equal(facts.merged, false);
  });

  t("openPr returns the PR's URL, readFacts shows it with the head SHA, and opening again returns the same PR", async ({ host, branch }, ticket) => {
    const head = await branch(ticket);
    const url = await host.openPr(ticket, "Closes ABT-1");
    assert.match(url, /^https?:\/\//);
    const facts = await host.readFacts(ticket);
    assert.equal(facts.pr, url);
    assert.equal(facts.headSha, head);
    assert.equal(facts.merged, false);
    assert.equal(await host.openPr(ticket), url);
  });

  t("closePr closes the open PR, and does nothing when there is none", async ({ host, branch }, ticket) => {
    await host.closePr(ticket);
    await branch(ticket);
    await host.openPr(ticket);
    await host.closePr(ticket);
    assert.equal((await host.readFacts(ticket)).pr, undefined);
    assert.equal((await host.readFacts(ticket)).merged, false);
    await host.closePr(ticket);
  });

  t("merge refuses when the head moved, and merges nothing", async ({ host, branch, advance }, ticket) => {
    const before = await branch(ticket);
    await host.openPr(ticket);
    const after = await advance(ticket);
    assert.notEqual(before, after);
    await assert.rejects(host.merge(ticket, { matchHeadSha: before }), HeadMovedError);
    const facts = await host.readFacts(ticket);
    assert.equal(facts.merged, false);
    assert.equal(facts.headSha, after);
  });

  t("merge at the current head squash-merges: it returns the merge commit and the PR cannot be closed after", async ({ host, branch }, ticket) => {
    const head = await branch(ticket);
    await host.openPr(ticket);
    const sha = await host.merge(ticket, { matchHeadSha: head });
    assert.ok(sha.length > 0);
    assert.equal((await host.readFacts(ticket)).merged, true);
    await assert.rejects(host.closePr(ticket));
  });

  t("postStatus puts a commit status on the commit", async ({ host, branch, statusOf }, ticket) => {
    const head = await branch(ticket);
    await host.postStatus(head, { context: "abt/validate", state: "failure", description: "trees/x.yaml:3:1 unknown node" });
    assert.equal(await statusOf(head, "abt/validate"), "failure");
    await host.postStatus(head, { context: "abt/validate", state: "success", description: "ok" });
    assert.equal(await statusOf(head, "abt/validate"), "success");
  });
}
