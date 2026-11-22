import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { codeHostContractSuite } from "./contract-suite.ts";
import { mainHostContractSuite } from "./main-host-suite.ts";

codeHostContractSuite("fake code host", () => {
  const host = new FakeCodeHost();
  const heads = new Map<string, number>();
  const head = (ticket: string) => `sha-${ticket}-${heads.get(ticket)}`;
  return {
    host,
    async branch(ticket) {
      heads.set(ticket, 1);
      host.setFacts(ticket, { headSha: head(ticket) });
      return head(ticket);
    },
    async advance(ticket) {
      heads.set(ticket, heads.get(ticket)! + 1);
      host.setFacts(ticket, { headSha: head(ticket) });
      return head(ticket);
    },
    async statusOf(sha, context) {
      return host.statuses.findLast((s) => s.sha === sha && s.status.context === context)?.status.state;
    },
  };
});

mainHostContractSuite("fake main host", () => {
  const host = new FakeCodeHost();
  let n = 0;
  return {
    host,
    async commit() {
      return `main-${++n}`;
    },
    async report(sha, job, state) {
      host.setMainJob(sha, job, state);
    },
    async reverts(sha) {
      return host.reverts.filter((r) => r.sha === sha).map((r) => ({ url: r.url, merged: false }));
    },
  };
});
