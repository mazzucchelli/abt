/** What a push says: which ticket and where to open it. Never any ticket content. */
export interface Push {
  ticket: string;
  url: string;
}

/** Reaches the human out of band. The ticket's own comments carry the substance; this only says "look". */
export interface Notifier {
  push(p: Push): Promise<void>;
}
