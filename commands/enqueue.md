---
description: Hand a ticket to abt as one work type (usage: /abt:enqueue <ticket> [implement|research|spike|bootstrap])
argument-hint: <ticket> [work type]
---

Enqueue a ticket with abt. This is your only dispatch action: do not evaluate gates, run the work or read the ticket in depth.

1. Run `abt enqueue $1 --type <work type>` from the project root (leave `--type` out when the user gave none; the ticket's own work type label is used).
2. Reply with the command's output, which is already the one-line ack. Do nothing else.

Refusals are final for this run and come with a reason. Relay the reason and stop. If the output offers onboarding (the project has no agreed merge policy), ask the user whether to onboard now. `abt onboard` is not implemented yet, so on a yes say that onboarding is not available yet and the merge policy must be agreed and committed to `.agents/abt/merge-policy.yaml` first.

If the output says the runner is not running and offers to start it, ask the user. Run `abt runner start` only after an explicit yes, never otherwise.

When the user replies in this chat to a ticket that is waiting on them (Needs you), do not act on it yourself: run `abt reply <ticket> <their words>` so it lands on the ticket as their comment, the one resume path.
