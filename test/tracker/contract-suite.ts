import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLY_KIND, type Tracker } from "../../src/tracker/contract.ts";

/**
 * One suite, run against every Tracker implementation so the fake cannot drift from reality.
 * `make` returns a tracker whose project is safe to write to (fresh fake, or a sandbox).
 */
export function contractSuite(name: string, make: () => Promise<Tracker> | Tracker, opts: { skip?: string | false } = {}): void {
  const t = (title: string, fn: (tracker: Tracker) => Promise<void>) =>
    test(`${name}: ${title}`, { skip: opts.skip || false, timeout: 120_000 }, async () => fn(await make()));
  const uniq = () => `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  t("createTicket makes an abt-marked Todo ticket that readTicket returns", async (tracker) => {
    const title = uniq();
    const created = await tracker.createTicket({ title, body: "body text", workType: "research", risk: "medium" });
    assert.equal(created.title, title);
    const read = await tracker.readTicket(created.id);
    assert.equal(read.id, created.id);
    assert.equal(read.title, title);
    assert.equal(read.body, "body text");
    assert.equal(read.state, "Todo");
    assert.equal(read.abt, true);
    assert.equal(read.workType, "research");
    assert.equal(read.risk, "medium");
    assert.equal(read.claimed, false);
    assert.deepEqual(read.links, []);
    assert.ok(read.owner !== "", "a ticket names its owner");
    assert.match(read.url, /^https?:\/\//, "a ticket has a url a human can open");
  });

  t("setState moves a ticket between lifecycle states and listByState sees it", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    assert.ok((await tracker.listByState("Todo")).some((x) => x.id === id));
    for (const state of ["In review", "Needs you", "Done", "Abandoned"] as const) {
      await tracker.setState(id, state);
      assert.equal((await tracker.readTicket(id)).state, state);
      assert.ok((await tracker.listByState(state)).some((x) => x.id === id), `listed under ${state}`);
      assert.ok(!(await tracker.listByState("Todo")).some((x) => x.id === id));
    }
  });

  t("claim takes a Todo ticket once", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    assert.equal(await tracker.claim(id), true);
    const read = await tracker.readTicket(id);
    assert.equal(read.state, "In progress");
    assert.equal(read.claimed, true);
    assert.equal(await tracker.claim(id), false);
  });

  t("claim refuses a ticket that is not in Todo", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.setState(id, "Done");
    assert.equal(await tracker.claim(id), false);
    assert.equal((await tracker.readTicket(id)).state, "Done");
  });

  t("structured comments round-trip and are read back in order", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.postComment(id, { kind: "decision", body: "Picked A", data: { n: 1, nested: { ok: true } } });
    await tracker.postComment(id, { kind: "note", body: "Second" });
    const page = await tracker.readCommentsSince(id);
    assert.deepEqual(
      page.comments.map(({ kind, body, data }) => ({ kind, body, data })),
      [
        { kind: "decision", body: "Picked A", data: { n: 1, nested: { ok: true } } },
        { kind: "note", body: "Second", data: {} },
      ],
    );
  });

  t("readCommentsSince returns only what is newer than the cursor", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.postComment(id, { kind: "note", body: "one" });
    const first = await tracker.readCommentsSince(id);
    assert.equal(first.comments.length, 1);
    assert.deepEqual((await tracker.readCommentsSince(id, first.cursor)).comments, []);
    await tracker.postComment(id, { kind: "note", body: "two" });
    const next = await tracker.readCommentsSince(id, first.cursor);
    assert.deepEqual(next.comments.map((c) => c.body), ["two"]);
    assert.deepEqual((await tracker.readCommentsSince(id, next.cursor)).comments, []);
  });

  t("attachLink shows up on the ticket", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.attachLink(id, { title: "PR", url: "https://example.com/pr/1" });
    assert.deepEqual((await tracker.readTicket(id)).links, [{ title: "PR", url: "https://example.com/pr/1" }]);
  });

  t("setRisk replaces the ticket's risk tier and keeps its other labels", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "", workType: "implement", risk: "low" });
    await tracker.setRisk(id, "high");
    let t = await tracker.readTicket(id);
    assert.equal(t.risk, "high");
    assert.equal(t.workType, "implement");
    assert.equal(t.abt, true);
    await tracker.setRisk(id, "medium");
    t = await tracker.readTicket(id);
    assert.equal(t.risk, "medium");
  });

  t("enqueue marks an existing ticket for abt as one work type, replacing another and leaving the rest alone", async (tracker) => {
    const { id } = await tracker.createTicket({ title: uniq(), body: "", workType: "research", risk: "medium" });
    await tracker.enqueue(id, "implement");
    const read = await tracker.readTicket(id);
    assert.equal(read.abt, true);
    assert.equal(read.workType, "implement");
    assert.equal(read.risk, "medium");
    assert.equal(read.state, "Todo");
    assert.ok((await tracker.listByState("Todo")).some((x) => x.id === id));
  });

  t("addBlocker makes the blocker block the ticket and keeps any blocker it already had", async (tracker) => {
    const a = await tracker.createTicket({ title: uniq(), body: "" });
    const b = await tracker.createTicket({ title: uniq(), body: "" });
    const c = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.addBlocker(c.id, a.id);
    await tracker.addBlocker(c.id, b.id);
    assert.deepEqual((await tracker.readTicket(c.id)).blockedBy.sort(), [a.id, b.id].sort());
    assert.deepEqual((await tracker.readTicket(a.id)).blockedBy, []);
    await tracker.addBlocker(c.id, a.id);
    assert.deepEqual((await tracker.readTicket(c.id)).blockedBy.sort(), [a.id, b.id].sort(), "asking again is not an error and adds nothing");
  });

  t("postReply writes a plain comment that reads back as the writer's reply", async (tracker) => {
    const { id, owner } = await tracker.createTicket({ title: uniq(), body: "" });
    await tracker.postReply(id, "yes");
    const [c] = (await tracker.readCommentsSince(id)).comments;
    assert.equal(c!.kind, REPLY_KIND);
    assert.equal(c!.body, "yes");
    assert.equal(c!.author, owner);
  });

  t("readTicket on an unknown id rejects", async (tracker) => {
    await assert.rejects(tracker.readTicket("NOPE-999999"));
  });
}
