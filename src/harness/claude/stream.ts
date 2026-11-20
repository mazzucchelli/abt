import type { UsageLimit } from "../contract.ts";

/** One line of `--output-format stream-json`, loosely typed: only the fields we read. */
export type StreamEvent = Record<string, any>;

export interface RunSummary {
  events: StreamEvent[];
  init?: StreamEvent;
  result?: StreamEvent;
  sessionId?: string;
  /** The last rate-limit event whose status is `rejected`. */
  rejectedLimit?: StreamEvent;
}

/** Parse the stream. Lines that are not JSON are ignored: a crashed run may leave a torn last line. */
export function parseStream(stdout: string): RunSummary {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (typeof e === "object" && e !== null) events.push(e);
    } catch {
      // torn line
    }
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.findLast((e) => e.type === "result");
  const rejectedLimit = events.findLast((e) => e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected");
  const sessionId = init?.session_id ?? result?.session_id ?? events.find((e) => typeof e.session_id === "string")?.session_id;
  return { events, ...(init && { init }), ...(result && { result }), ...(rejectedLimit && { rejectedLimit }), ...(sessionId && { sessionId }) };
}

/**
 * A usage limit ends the run with an error result carrying HTTP 429. The exit code alone is not enough
 * (an auth failure also exits 1), and `blocking_limit` means a full context window, not a usage limit.
 */
export function usageLimitOf(s: RunSummary): UsageLimit | undefined {
  if (!(s.result?.is_error === true && s.result.api_error_status === 429)) return undefined;
  const info = s.rejectedLimit?.rate_limit_info;
  return {
    ...(typeof info?.rateLimitType === "string" && { rateLimitType: info.rateLimitType }),
    ...(typeof info?.resetsAt === "number" && { resetsAt: info.resetsAt }),
  };
}
