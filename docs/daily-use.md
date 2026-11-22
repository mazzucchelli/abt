# Day-to-day use

You work in two places: a **Claude Code chat** at the project root (with the plugin loaded) to hand work over, and **Linear** to answer when abt needs you. Run the `abt` commands below from the project root; each one also takes `--project <dir>`.

## Hand work over

### One ticket

```
/abt:enqueue MP-12
```

The agent runs `abt enqueue MP-12` and relays the one-line ack with the ticket link. The ticket's **work type** comes from, strongest first:

1. a type you name: `/abt:enqueue MP-12 research` → `--type research`;
2. a work-type label the ticket already carries;
3. the type the entry point implies (`--entry`);
4. the agent's own reading of the request (`--inferred`). It is written back to the ticket as a `work-type-inferred` comment, and the ack says "(inferred)".

The agent asks you only when the type is ambiguous, or when the request reads as exploratory but would be inferred as implement. It never infers `bootstrap`.

### Several tickets

```
/abt:enqueue MP-12 MP-13:research MP-14
```

You get a table: ticket, work type, blocked by (blockers not merged yet) and expected start. A ticket that can't be queued shows as a row with the reason; it doesn't stop the others.

### Free text, no ticket yet

```
/abt:enqueue add a --json flag to the status command
```

The agent runs `abt create -- <your words>`. It creates the Linear ticket first, then enqueues it. The type and policy checks run before the ticket exists, so a refusal leaves nothing behind.

### Collisions and blockers

When two tickets name the same file or module, the reply asks whether the newer one should wait for the older. Say yes and the agent runs `abt block <ticket> <blocker>`, which adds a Linear "blocked by" relation. A blocked ticket is dispatched only once its blocker is Done. You can also set blockers directly in Linear.

### Without the chat

Every slash command is a thin wrapper around the CLI:

```bash
abt enqueue MP-12 --type implement
abt enqueue MP-12 MP-13:research MP-14 --inferred implement
abt create --inferred implement -- "Add a --json flag to abt status"
abt block MP-14 MP-12
```

## See what's happening

```bash
abt watch          # live board of all workers: b board, j/k scroll the log, space pause, q quit
abt watch --once   # print one frame and exit (works without a terminal)
abt runner status
```

Linear shows the coarse state of each ticket (Todo, In progress, In review, Needs you, Done, Abandoned) and the risk label, and the PR is linked on the ticket.

## When a ticket needs you

A ticket goes to **Needs you** when abt stops to ask: an escalated ask-point, a high-risk spec waiting for approval, a failed run, a drift or pin mismatch, or a red job after a merge. abt posts **one comment** on the ticket with the question, its recommendation, the evidence and whether the choice is reversible. Linear's notification for that comment is your doorbell.

Reply **on the ticket**, as its owner, with one of the commands below. The owner is the Linear user who created the ticket (for `abt create`, the user the API key belongs to). Comments from anyone else are ignored.

| Reply | Effect |
| --- | --- |
| `yes` | take the recommendation |
| `answer: <your answer>` | resume with your answer |
| `re-run` | run the ticket again |
| `raise tier` | raise the risk tier one step (more of the following work comes to you) |
| `abandon` | stop; the ticket becomes Abandoned and its worktree is removed |

Anything else is logged as a note and does not resume the ticket. Silence is never consent: after a while abt reminds you.

If you'd rather answer from the chat, tell the agent. It runs `abt reply MP-12 "answer: use postgres"`, which posts your words to the ticket as your comment. The ticket stays the one place a reply comes from.

## Approve a PR

Medium- and high-risk PRs, and any PR above the policy's `risk_cap`, need your approval on GitHub. Review and approve as usual. On its next poll the land tree sees the approval, re-checks CI and the head SHA, and merges. If nobody approves within 2 days, the ticket goes to Needs you.

In a pr-only project, abt leaves the PR for you to merge. Merging it yourself moves the ticket to Done.

## Change a ticket's work type mid-run

Only you can do it: change the work-type label on the Linear ticket. On the next pass abt stops the current worker, writes a `retype` record, keeps the risk tier (it never drops) and starts the new type's tree. A worker that thinks the type is wrong can only ask you through an ask-point.

## Audit a run

```bash
abt log show MP-12             # the latest run of the ticket
abt log show MP-12 --run <id>  # one run
```

[Reading a decision log](reference/decision-log.md) explains the columns and record kinds. Worker transcripts are in `~/.agents/abt/runs/MP-12/` for 30 days after the ticket finishes. A failed run's worktree is kept 7 days under `$ABT_HOME/worktrees/<project>/`.

## Upgrade and roll back

The runner, its workers and `bin/abt` all run the **pinned install** that `$ABT_HOME/current` points at, so your edits in the abt checkout never touch live runs.

```bash
abt upgrade <tag> --from <git url or path>   # install the tag, self-test it, switch current only if the test passes
abt upgrade <older tag>                      # already installed: a rollback, current just moves
abt upgrade --list                           # installed tags, current marked with *
abt selftest                                 # the self-test of the install you're running
```

`--from` defaults to `$ABT_REPO`, else the `origin` of the abt that is running. A failed self-test leaves `current` where it was and removes the attempt. Set `ABT_UNPINNED=1` to run your checkout instead of the pinned install for one command.

## Planning helpers

These run a procedure with you in the chat. They don't start a worker.

| Command | What it does |
| --- | --- |
| `/abt:to-spec` | turns the conversation into a spec on the tracker |
| `/abt:to-tickets <plan>` | splits a plan into vertical-slice tickets |
| `/abt:triage <ticket>...` | moves tickets toward agent-ready briefs |
| `/abt:grill-with-docs <plan>` | interviews you about a plan, updating `GLOSSARY.md` and ADRs as decisions land |

---

Something not working? See [troubleshooting](troubleshooting.md).
