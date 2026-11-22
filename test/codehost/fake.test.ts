import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { codeHostContractSuite } from "./contract-suite.ts";

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
