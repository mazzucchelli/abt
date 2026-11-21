---
description: Hand tickets or free text to abt as a work type (usage: /abt:enqueue <ticket>... | <free text> [implement|research|spike|bootstrap])
argument-hint: <ticket>... | <free text> [work type]
---

Enqueue work with abt. This is your only dispatch action: do not evaluate gates, run the work or read a ticket in depth.

## Pick the entry point

- One ticket: `abt enqueue <ticket>`.
- Several tickets: one `abt enqueue <ticket> <ticket> ...` command. It returns the summary table (ticket, work type, blocked by, expected start). Relay it as is. To give one ticket its own type write `<ticket>:<type>`.
- Free text and no ticket: `abt create [flags] -- <the user's words>` (the `--` keeps words like `--type` in the text from being read as flags). It makes the tracker ticket first, then enqueues it, so nothing happens off the tracker. Never queue work that has no ticket.

Run these from the project root. A single ticket is also checked against work in flight, so its ack may be followed by a blocker question.

## Pick the work type

The strongest source wins: an explicit type or label, then the type the entry point implies, then your own guess.

1. The user named a type: pass `--type <work type>`. A label the ticket already carries counts the same way, so pass nothing for it.
2. The entry point implies one (a research command, say): pass `--entry <work type>`.
3. Neither: read the request and pass your guess as `--inferred <work type>`. abt writes it back to the tracker marked "inferred" and says so in the ack.

Ask the user, and run nothing, only when the type is ambiguous. If you would infer implement but the work reads as exploratory (a question, a comparison, "is X worth it"), pass `--exploratory` with `--inferred implement` and abt answers with the question to relay. Never infer `bootstrap`; it needs the user to ask for it, and abt refuses it as a guess.

## Reply

Reply with the command's output, which is already the ack or the table. Do nothing else.

Refusals are final for this run and come with a reason. Relay the reason and stop. If the output offers onboarding (the project has no agreed merge policy), ask the user whether to onboard now. On a yes, run `/abt:onboard`.

If the output says the runner is not running and offers to start it, ask the user. Run `abt runner start` only after an explicit yes, never otherwise.

## Collisions

When the output asks whether a ticket should wait for another because they likely touch the same files, relay the question and write nothing yet. On a yes run `abt block <ticket> <blocker>` with the two tickets the question names. On a no, leave them.

## Escalation replies

When the user replies in this chat to a ticket that is waiting on them (Needs you), do not act on it yourself: run `abt reply <ticket> <their words>` so it lands on the ticket as their comment, the one resume path.
