import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, orderCandidates, type Candidate } from "../../src/runner/scheduler.ts";

const c = (key: string, queue: Candidate["queue"], priority = 0, createdAt = "2026-01-01T00:00:00Z", project = "p"): Candidate => ({
  key, project, queue, priority, createdAt,
});

test("dispatch order: usage-limit requeues, then in-flight trees, then new tickets", () => {
  const order = orderCandidates([c("new", "new", 1), c("flight", "in-flight", 4), c("limit", "usage-limit", 0)]);
  assert.deepEqual(order.map((x) => x.key), ["limit", "flight", "new"]);
});

test("within a queue: priority first (urgent to low, none last), then oldest first", () => {
  const order = orderCandidates([
    c("none-old", "new", 0, "2026-01-01T00:00:00Z"),
    c("low", "new", 4, "2026-01-01T00:00:00Z"),
    c("urgent-new", "new", 1, "2026-01-03T00:00:00Z"),
    c("urgent-old", "new", 1, "2026-01-02T00:00:00Z"),
  ]);
  assert.deepEqual(order.map((x) => x.key), ["urgent-old", "urgent-new", "low", "none-old"]);
});

test("admit fills the free global slots in order", () => {
  const all = ["a", "b", "c", "d", "e"].map((k) => c(k, "new"));
  assert.deepEqual(admit(all, { held: [], globalCap: 3, projectCaps: {} }).map((x) => x.key), ["a", "b", "c"]);
  assert.deepEqual(admit(all, { held: ["p", "p"], globalCap: 3, projectCaps: {} }).map((x) => x.key), ["a"]);
  assert.deepEqual(admit(all, { held: ["p", "p", "p"], globalCap: 3, projectCaps: {} }), []);
});

test("a per-project cap holds that project back without blocking the others", () => {
  const all = [c("a1", "new", 0, "2026-01-01T00:00:01Z", "a"), c("a2", "new", 0, "2026-01-01T00:00:02Z", "a"), c("b1", "new", 0, "2026-01-01T00:00:03Z", "b")];
  const got = admit(all, { held: [], globalCap: 3, projectCaps: { a: 1 } });
  assert.deepEqual(got.map((x) => x.key), ["a1", "b1"]);
  assert.deepEqual(admit(all, { held: ["a"], globalCap: 3, projectCaps: { a: 1 } }).map((x) => x.key), ["b1"]);
});
