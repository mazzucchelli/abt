import { LIFECYCLE_STATES, OPTIONAL_STATES, RISK_TIERS, WORK_TYPES, type LifecycleState } from "../tracker/contract.ts";
import type { LabelConfig } from "../tracker/config.ts";

const ENDPOINT = "https://api.linear.app/graphql";

/** The Linear state type each lifecycle state needs when abt has to create it. Only `Needs you` is ever missing from a fresh team. */
const STATE_TYPE: Record<LifecycleState, string> = {
  Backlog: "backlog",
  Todo: "unstarted",
  "In progress": "started",
  "In review": "started",
  "Needs you": "started",
  Done: "completed",
  Abandoned: "canceled",
  Duplicate: "canceled",
};
const STATE_COLOR = "#F2C94C";
const LABEL_COLOR = "#95A2B3";

export interface TrackerSetupOptions {
  apiKey: string;
  team: string;
  /** Lifecycle state -> Linear state name, as the adapter doc maps them. */
  states: Record<LifecycleState, string>;
  labels: LabelConfig;
  fetch?: typeof fetch;
  endpoint?: string;
}

export interface TrackerSetupResult {
  createdStates: string[];
  createdLabels: string[];
  /** Everything the adapter doc names that the team already had. */
  existing: string[];
}

/**
 * Makes team `team` ready for abt: the lifecycle states and labels the adapter doc names, created when missing and
 * never renamed or deleted. The team itself must exist (a member key cannot create one). Safe to run again.
 * Backlog and Duplicate are never created: Linear gives every team them, and abt only recognises them.
 */
export async function setupTracker(o: TrackerSetupOptions): Promise<TrackerSetupResult> {
  const http = o.fetch ?? fetch;
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await http(o.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: o.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) {
      throw new Error(`Linear request failed: ${body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`}`);
    }
    return body.data;
  };

  const found = await gql<{
    teams: { nodes: { id: string; states: { nodes: { name: string }[] } }[] };
    issueLabels: { nodes: { name: string }[] };
  }>(
    `query($team: String!) {
       teams(filter: { key: { eq: $team } }) { nodes { id states(first: 100) { nodes { name } } } }
       issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) { nodes { name } }
     }`,
    { team: o.team },
  );
  const team = found.teams.nodes[0];
  if (!team) throw new Error(`Linear has no team with the key "${o.team}": create the team in Linear first, then run this again`);

  const haveStates = new Set(team.states.nodes.map((s) => s.name));
  const haveLabels = new Set(found.issueLabels.nodes.map((l) => l.name));
  const result: TrackerSetupResult = { createdStates: [], createdLabels: [], existing: [] };

  for (const s of LIFECYCLE_STATES) {
    const name = o.states[s];
    if (haveStates.has(name)) result.existing.push(`state ${name}`);
    else if (OPTIONAL_STATES.includes(s)) continue;
    else {
      await gql(
        `mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }`,
        { input: { teamId: team.id, name, type: STATE_TYPE[s], color: STATE_COLOR } },
      );
      haveStates.add(name);
      result.createdStates.push(name);
    }
  }

  const labels = [o.labels.abt, ...WORK_TYPES.map((w) => o.labels.workType[w]), ...RISK_TIERS.map((r) => o.labels.risk[r])];
  for (const name of labels) {
    if (haveLabels.has(name)) result.existing.push(`label ${name}`);
    else {
      await gql(
        `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`,
        { input: { teamId: team.id, name, color: LABEL_COLOR } },
      );
      haveLabels.add(name);
      result.createdLabels.push(name);
    }
  }
  return result;
}

export function describeSetup(team: string, r: TrackerSetupResult): string {
  const lines = [`team ${team}:`];
  lines.push(r.createdStates.length ? `  created states: ${r.createdStates.join(", ")}` : "  states: all there");
  lines.push(r.createdLabels.length ? `  created labels: ${r.createdLabels.join(", ")}` : "  labels: all there");
  return lines.join("\n");
}
