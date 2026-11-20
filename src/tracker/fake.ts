import {
  type Comment,
  type CommentPage,
  type Link,
  type LifecycleState,
  type NewTicket,
  type StructuredComment,
  type Ticket,
  type Tracker,
} from "./contract.ts";

/** In-memory Tracker for tests. Held to the same contract suite as the real modules. */
export class InMemoryTracker implements Tracker {
  #tickets = new Map<string, Ticket>();
  #comments = new Map<string, Comment[]>();
  #seq = 0;

  async readTicket(id: string): Promise<Ticket> {
    return structuredClone(this.#get(id));
  }

  async listByState(state: LifecycleState): Promise<Ticket[]> {
    return [...this.#tickets.values()].filter((t) => t.abt && t.state === state).map((t) => structuredClone(t));
  }

  async setState(id: string, state: LifecycleState): Promise<void> {
    this.#get(id).state = state;
  }

  async claim(id: string): Promise<boolean> {
    const t = this.#get(id);
    if (t.state !== "Todo" || t.claimed) return false;
    t.state = "In progress";
    t.claimed = true;
    return true;
  }

  async postComment(id: string, c: StructuredComment): Promise<void> {
    this.#get(id);
    const list = this.#comments.get(id) ?? [];
    list.push({
      id: `c${++this.#seq}`,
      kind: c.kind,
      body: c.body,
      data: structuredClone(c.data ?? {}),
      createdAt: new Date().toISOString(),
    });
    this.#comments.set(id, list);
  }

  async readCommentsSince(id: string, cursor?: string): Promise<CommentPage> {
    this.#get(id);
    const all = this.#comments.get(id) ?? [];
    const seen = cursor === undefined ? 0 : Number(cursor);
    return { comments: structuredClone(all.slice(seen)), cursor: String(all.length) };
  }

  async createTicket(input: NewTicket): Promise<Ticket> {
    const ticket: Ticket = {
      id: `FAKE-${++this.#seq}`,
      title: input.title,
      body: input.body,
      state: "Todo",
      abt: true,
      claimed: false,
      links: [],
      ...(input.workType && { workType: input.workType }),
      ...(input.risk && { risk: input.risk }),
    };
    this.#tickets.set(ticket.id, ticket);
    return structuredClone(ticket);
  }

  async attachLink(id: string, link: Link): Promise<void> {
    this.#get(id).links.push({ ...link });
  }

  #get(id: string): Ticket {
    const t = this.#tickets.get(id);
    if (!t) throw new Error(`no such ticket: ${id}`);
    return t;
  }
}
