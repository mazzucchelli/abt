/** The closed tracker contract: eleven operations, tracker-neutral. */

export const LIFECYCLE_STATES = [
  "Todo",
  "In progress",
  "In review",
  "Needs you",
  "Done",
  "Abandoned",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const WORK_TYPES = ["implement", "research", "spike", "bootstrap"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const RISK_TIERS = ["low", "medium", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export interface Link {
  title: string;
  url: string;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
  state: LifecycleState;
  /** Whether the ticket carries the abt marker. */
  abt: boolean;
  workType?: WorkType;
  risk?: RiskTier;
  /** Whether someone has claimed the ticket. */
  claimed: boolean;
  links: Link[];
  /** Linear's scale: 1 urgent, 2 high, 3 medium, 4 low, 0 none. */
  priority: number;
  /** When the ticket was created (ISO), so the scheduler can take the oldest first. */
  createdAt: string;
  /** IDs of the tickets that block this one. It is dispatched only once every one has merged. */
  blockedBy: string[];
  /** Who owns the ticket (its creator). Only the owner's replies steer a run. */
  owner: string;
  /** Where a human opens the ticket. */
  url: string;
}

export interface NewTicket {
  title: string;
  body: string;
  workType?: WorkType;
  risk?: RiskTier;
  priority?: number;
  blockedBy?: string[];
}

/** A machine-readable comment: a kind, readable text and optional JSON data. */
export interface StructuredComment {
  kind: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface Comment extends StructuredComment {
  id: string;
  createdAt: string;
  /** Who wrote it. Set on a human's reply; abt's own comments carry none. */
  author?: string;
}

/** The kind a comment abt did not write is read back as. Its body is the human's own words. */
export const REPLY_KIND = "reply";

export interface CommentPage {
  comments: Comment[];
  /** Opaque. Pass it back to read only what was posted after this page. */
  cursor: string;
}

export interface Tracker {
  readTicket(id: string): Promise<Ticket>;
  /** abt-marked tickets currently in the given lifecycle state. */
  listByState(state: LifecycleState): Promise<Ticket[]>;
  setState(id: string, state: LifecycleState): Promise<void>;
  /** Moves a Todo ticket to In progress and marks it claimed. False if it was not claimable. */
  claim(id: string): Promise<boolean>;
  postComment(id: string, comment: StructuredComment): Promise<void>;
  /** Comments in posting order. Without a cursor, all of them. */
  readCommentsSince(id: string, cursor?: string): Promise<CommentPage>;
  /** Creates an abt-marked ticket in Todo. */
  createTicket(input: NewTicket): Promise<Ticket>;
  attachLink(id: string, link: Link): Promise<void>;
  /**
   * Hands an existing ticket to abt in one write: adds the abt marker and the work type label,
   * replacing any other work type label and leaving every other label and the state alone.
   */
  enqueue(id: string, workType: WorkType): Promise<void>;
  /** A plain comment from whoever holds the tracker credential, read back as a reply by that user. Carries no abt marker. */
  postReply(id: string, body: string): Promise<void>;
  /** Sets the ticket's risk tier label, replacing any other tier label and leaving every other label alone. */
  setRisk(id: string, tier: RiskTier): Promise<void>;
}

const MARKER = /\n\n<!-- abt:(\S+) ([A-Za-z0-9+/=]*) -->\s*$/;

/** Encode a structured comment as markdown text that stays readable in any tracker UI. */
export function encodeComment(c: StructuredComment): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(c.kind) || c.kind.includes("--")) {
    throw new Error(`invalid comment kind ${JSON.stringify(c.kind)}: use letters, digits, . _ : - (no "--")`);
  }
  const data = Buffer.from(JSON.stringify(c.data ?? {})).toString("base64");
  return `${c.body}\n\n<!-- abt:${c.kind} ${data} -->`;
}

/** Inverse of encodeComment. Returns undefined for comments abt did not write. */
export function decodeComment(text: string): StructuredComment | undefined {
  const m = MARKER.exec(text);
  if (!m) return undefined;
  const data = JSON.parse(Buffer.from(m[2]!, "base64").toString("utf8")) as Record<string, unknown>;
  return { kind: m[1]!, body: text.slice(0, m.index), data };
}
