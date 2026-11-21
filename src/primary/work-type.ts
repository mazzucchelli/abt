import { WORK_TYPES, type WorkType } from "../tracker/contract.ts";

/** Where a work type came from, strongest first. */
export type TypeSource = "command" | "label" | "entry" | "inferred";

/** What the primary agent worked out from the request's own words. */
export interface Inference {
  workType: string;
  /** The work reads as exploratory (a question, a comparison), so implement would be a guess. */
  exploratory?: boolean;
}

/** What a request says about its type, from the command, the entry point and the agent's own reading. */
export interface Intake {
  /** The type the user named in the command. */
  workType?: string;
  /** The type the entry point the user used implies. */
  entryType?: string;
  /** The agent's own reading of the request, used only when nothing above names a type. */
  inferred?: Inference;
}

export interface TypeInputs {
  /** The type the user named in the command. */
  command?: string;
  /** The type label the ticket already carries. */
  label?: WorkType;
  /** The type implied by the entry point the user used (a research command, say). */
  entry?: string;
  inferred?: Inference;
}

export type TypeResolution =
  | { ok: true; workType: WorkType; source: TypeSource }
  | { ok: false; outcome: "refused"; reply: string }
  | { ok: false; outcome: "ask"; reply: string };

const isWorkType = (s: string): s is WorkType => (WORK_TYPES as readonly string[]).includes(s);
const pick = `Pick one of ${WORK_TYPES.join(", ")}.`;
const notAType = (value: string): TypeResolution => ({ ok: false, outcome: "refused", reply: `Not queued: ${JSON.stringify(value)} is not a work type. ${pick}` });

/** The resolver's inputs for a request, with the ticket's own label if it has one. */
export function typeInputs(intake: Intake, label?: WorkType): TypeInputs {
  return {
    ...(intake.workType !== undefined && { command: intake.workType }),
    ...(label && { label }),
    ...(intake.entryType !== undefined && { entry: intake.entryType }),
    ...(intake.inferred && { inferred: intake.inferred }),
  };
}

/**
 * An explicit label or command beats the type the entry point implies, which beats the agent's own guess.
 * A named type that is not a work type is refused, never skipped. A guess is never bootstrap, and a guess of
 * implement for exploratory work is a question for the user rather than a decision.
 */
export function resolveWorkType(subject: string, input: TypeInputs): TypeResolution {
  const named: [TypeSource, string | undefined][] = [
    ["command", input.command],
    ["label", input.label],
    ["entry", input.entry],
  ];
  const [source, value] = named.find(([, v]) => v !== undefined) ?? [];
  if (source && value !== undefined) {
    if (!isWorkType(value)) return notAType(value);
    return { ok: true, workType: value, source };
  }

  const guess = input.inferred;
  if (!guess) return { ok: false, outcome: "refused", reply: `Not queued: ${subject} has no work type. ${pick}` };
  if (!isWorkType(guess.workType)) return notAType(guess.workType);
  if (guess.workType === "bootstrap") {
    return { ok: false, outcome: "refused", reply: `Not queued: bootstrap is never inferred. Ask for it explicitly if ${subject} should add verification tooling. ${pick}` };
  }
  if (guess.workType === "implement" && guess.exploratory) {
    return {
      ok: false,
      outcome: "ask",
      reply: `${subject} looks exploratory, so implement may be wrong. Should it be research (ends in a doc), spike (throwaway code that answers a question) or implement (ends in a merged PR)?`,
    };
  }
  return { ok: true, workType: guess.workType, source: "inferred" };
}
