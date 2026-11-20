import type { TrackerConfig } from "./config.ts";
import {
  LIFECYCLE_STATES,
  RISK_TIERS,
  WORK_TYPES,
  decodeComment,
  encodeComment,
  type Comment,
  type CommentPage,
  type LifecycleState,
  type Link,
  type NewTicket,
  type StructuredComment,
  type Ticket,
  type Tracker,
} from "./contract.ts";

const ENDPOINT = "https://api.linear.app/graphql";

export interface LinearOptions {
  apiKey: string;
  fetch?: typeof fetch;
  endpoint?: string;
}

interface IssueNode {
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  assignee: { id: string } | null;
  labels: { nodes: { name: string }[] };
  attachments: { nodes: { title: string | null; url: string }[] };
}

const ISSUE_FIELDS = `identifier title description state { name } assignee { id }
  labels { nodes { name } } attachments { nodes { title url } }`;

/**
 * Linear as the tracker. Checks at startup that every mapped state and label exists
 * in the team, so a bad adapter doc stops the run before any ticket is touched.
 */
export async function createLinearTracker(config: TrackerConfig, opts: LinearOptions): Promise<Tracker> {
  const http = opts.fetch ?? fetch;
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await http(opts.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: opts.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) {
      const why = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Linear request failed: ${why}`);
    }
    return body.data;
  };

  const setup = await gql<{
    team: { id: string; states: { nodes: { id: string; name: string }[] } };
    issueLabels: { nodes: { id: string; name: string }[] };
  }>(
    `query($team: String!) {
       team(id: $team) { id states(first: 100) { nodes { id name } } }
       issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) {
         nodes { id name }
       }
     }`,
    { team: config.team },
  );
  const stateIds = new Map(setup.team.states.nodes.map((s) => [s.name, s.id]));
  const labelIds = new Map(setup.issueLabels.nodes.map((l) => [l.name, l.id]));

  const missingStates = LIFECYCLE_STATES.filter((s) => !stateIds.has(config.states[s]));
  if (missingStates.length > 0) {
    throw new Error(
      `adapter doc maps lifecycle states to Linear states that team ${config.team} does not have: ` +
        missingStates.map((s) => `${s} -> "${config.states[s]}"`).join(", "),
    );
  }
  const wanted = [config.labels.abt, ...Object.values(config.labels.workType), ...Object.values(config.labels.risk)];
  const missingLabels = wanted.filter((l) => !labelIds.has(l));
  if (missingLabels.length > 0) {
    throw new Error(`Linear is missing labels named in the adapter doc: ${missingLabels.map((l) => `"${l}"`).join(", ")}`);
  }

  const lifecycleOf = new Map(LIFECYCLE_STATES.map((s) => [config.states[s], s] as const));
  const stateId = (s: LifecycleState) => stateIds.get(config.states[s])!;

  const toTicket = (n: IssueNode): Ticket => {
    const state = lifecycleOf.get(n.state.name);
    if (!state) {
      throw new Error(`ticket ${n.identifier} is in Linear state "${n.state.name}", which the adapter doc does not map`);
    }
    const names = new Set(n.labels.nodes.map((l) => l.name));
    const workType = WORK_TYPES.find((w) => names.has(config.labels.workType[w]));
    const risk = RISK_TIERS.find((r) => names.has(config.labels.risk[r]));
    return {
      id: n.identifier,
      title: n.title,
      body: n.description ?? "",
      state,
      abt: names.has(config.labels.abt),
      claimed: n.assignee !== null,
      links: n.attachments.nodes.map((a) => ({ title: a.title ?? a.url, url: a.url })),
      ...(workType && { workType }),
      ...(risk && { risk }),
    };
  };

  const readIssue = async (id: string) =>
    (await gql<{ issue: IssueNode }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id })).issue;

  const update = async (id: string, input: Record<string, unknown>) => {
    const r = await gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id, input },
    );
    if (!r.issueUpdate.success) throw new Error(`Linear refused to update ${id}`);
  };

  return {
    async readTicket(id) {
      return toTicket(await readIssue(id));
    },

    async listByState(state) {
      const out: Ticket[] = [];
      let after: string | null = null;
      do {
        const page: { issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
          await gql(
            `query($filter: IssueFilter, $after: String) {
               issues(filter: $filter, first: 100, after: $after) {
                 nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
               }
             }`,
            {
              after,
              filter: {
                team: { id: { eq: setup.team.id } },
                state: { name: { eq: config.states[state] } },
                labels: { name: { eq: config.labels.abt } },
              },
            },
          );
        out.push(...page.issues.nodes.map(toTicket));
        after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
      } while (after);
      return out;
    },

    async setState(id, state) {
      await update(id, { stateId: stateId(state) });
    },

    /** Linear has no compare-and-set: read, then write. The runner is the only claimer. */
    async claim(id) {
      const issue = await readIssue(id);
      if (issue.state.name !== config.states.Todo || issue.assignee) return false;
      const { viewer } = await gql<{ viewer: { id: string } }>(`query { viewer { id } }`);
      await update(id, { stateId: stateId("In progress"), assigneeId: viewer.id });
      return true;
    },

    async postComment(id, comment: StructuredComment) {
      const r = await gql<{ commentCreate: { success: boolean } }>(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: id, body: encodeComment(comment) } },
      );
      if (!r.commentCreate.success) throw new Error(`Linear refused the comment on ${id}`);
    },

    /** The cursor is the createdAt of the newest comment seen. */
    async readCommentsSince(id, cursor): Promise<CommentPage> {
      const all: { id: string; body: string; createdAt: string }[] = [];
      let after: string | null = null;
      do {
        const page: {
          issue: {
            comments: {
              nodes: { id: string; body: string; createdAt: string }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        } = await gql(
          `query($id: String!, $filter: CommentFilter, $after: String) {
             issue(id: $id) {
               comments(filter: $filter, first: 100, after: $after) {
                 nodes { id body createdAt } pageInfo { hasNextPage endCursor }
               }
             }
           }`,
          { id, after, filter: cursor ? { createdAt: { gt: cursor } } : null },
        );
        all.push(...page.issue.comments.nodes);
        after = page.issue.comments.pageInfo.hasNextPage ? page.issue.comments.pageInfo.endCursor : null;
      } while (after);
      all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const comments: Comment[] = [];
      for (const c of all) {
        const decoded = decodeComment(c.body);
        if (decoded) comments.push({ id: c.id, createdAt: c.createdAt, ...decoded });
      }
      return { comments, cursor: all.at(-1)?.createdAt ?? cursor ?? new Date(0).toISOString() };
    },

    async createTicket(input: NewTicket) {
      const labelNames = [config.labels.abt];
      if (input.workType) labelNames.push(config.labels.workType[input.workType]);
      if (input.risk) labelNames.push(config.labels.risk[input.risk]);
      const r = await gql<{ issueCreate: { success: boolean; issue: IssueNode } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        {
          input: {
            teamId: setup.team.id,
            title: input.title,
            description: input.body,
            stateId: stateId("Todo"),
            labelIds: labelNames.map((l) => labelIds.get(l)!),
          },
        },
      );
      if (!r.issueCreate.success) throw new Error("Linear refused to create the ticket");
      return toTicket(r.issueCreate.issue);
    },

    async attachLink(id, link: Link) {
      const r = await gql<{ attachmentCreate: { success: boolean } }>(
        `mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
        { input: { issueId: id, title: link.title, url: link.url } },
      );
      if (!r.attachmentCreate.success) throw new Error(`Linear refused the link on ${id}`);
    },

    async setRisk(id, tier) {
      const names = config.labels.risk;
      await update(id, {
        addedLabelIds: [labelIds.get(names[tier])!],
        removedLabelIds: RISK_TIERS.filter((r) => r !== tier).map((r) => labelIds.get(names[r])!),
      });
    },
  };
}
