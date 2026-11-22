# Glossary

Domain terms for the AI workflow. Definitions only, no implementation detail.

**Entry point**: The way the human starts one or more activities, typically a command in a Claude Code or opencode chat, usually with a ticket.

**Primary agent**: The single conversational agent that receives work from every entry point, knows how to react to each, prepares the ticket and hands it to the runner. It never evaluates a gate.

**Runner**: The deterministic program that runs a ticket's behavior tree, executes its checks and spawns worker agents for its agent actions. It holds dispatch state only and enforces the invariants no tree can remove.

**Pass**: One run of a ticket's behavior tree from the root. A pass happens when the ticket's worker ends, when the primary agent nudges the runner, or on a regular poll.

**Worker slot**: Permission for one worker agent to be running. Slots are shared across all projects on a machine, with an optional lower cap per project (both caps are configured as `maxWorkers`), and only a running worker holds one: a ticket waiting on CI, an approval, a blocker or the human holds none.

**Behavior tree**: The definition of how one work type moves from ticket to done: a tree of conditions (facts read from the world) and actions, re-run from the root on every pass, with no state stored inside it.

**Work type**: The kind of a ticket (for example implement or research), chosen at intake; it selects which behavior tree runs. There are four: implement (ends in a merged PR), research (ends in a doc, no code), spike (throwaway code that answers a question, never merged; prototypes are spikes with a human in the loop) and bootstrap (adds missing verification tooling). A ticket has exactly one.

**Retype**: Changing a ticket's work type mid-run. Only the human can do it; a worker that sees a type mismatch raises an ask-point instead. The ticket's risk tier carries over and never drops.

**Inferred work type**: A work type the primary agent guessed from the request because no label, command or entry point named one. It is written back to the tracker marked "inferred". An explicit label or command beats the type the entry point implies, which beats an inferred one. Bootstrap is never inferred.

**Collision**: Two tickets that likely touch the same files, found by the file or module paths their text names. The primary agent asks whether to add a blocker edge; it never adds one unasked.

**Blocker edge**: A tracker relation that makes one ticket wait for another to merge before it is dispatched.

**Lifecycle state**: The coarse, human-visible state of a ticket in the tracker: Todo, In progress, In review, Needs you, Done or Abandoned.

**Harness**: The agent program a worker runs inside (for example Claude Code, opencode or Codex). Behavior trees never name one.

**Harness adapter**: The part of the runner that turns a harness-neutral agent action into a run of one specific harness, and reports back how it ended.

**Launch profile**: The mapping from a harness-neutral agent action to the actual command that starts a worker: which harness, which account or gateway, and which pinned model ID each model family resolves to. Which family and effort a complexity grade uses is routing's choice, not the profile's.

**Adapter doc**: A project's own workflow file, `workflow.md`, that tells the runner how that project is set up (for example its isolation settings). It is a protected file, separate from the merge policy.

**Worker agent**: An agent dispatched by the runner to carry out one unit of work, running at the model and effort the routing chose.

**Autonomous merge**: An agent merging its own PR into the default branch after every gate in the project's agreed merge policy has passed. This says when a merge is allowed; the runner-merge is how it happens. A human approval can be one of those gates; the no-human case is the policy with zero required approvals. Never a direct push.

**Merge policy**: The per-project agreement, kept in a file separate from the adapter doc and made when the workflow is first initiated there, of when an autonomous merge may happen: which checks and human approvals are required, who enforces them, the compensating controls, the risk cap and whether abt merges at all or only opens the PR. Without an agreed policy, or when it says PR only, the agent does not merge.

**Merge-policy preset**: A ready-made starting merge policy that onboarding proposes from a project's probed facts: pr-only (the fallback), solo-self, solo-server or team-reviewed. The human edits it before agreeing.

**Onboarding**: The conversation in which the workflow first meets a project: it probes the project's facts, proposes a preset and a risk map, and ends with the human agreeing to a merge policy. Until then the project is pr-only.

**Facts snapshot**: The probed project facts (enforcement, required checks, writers, CI jobs, test tooling) that a merge policy was agreed against. Its cheap facts are also recorded in the policy's `facts`, which is what drift is measured against.

**Cheap facts**: The project facts that cost one host API read each (default branch, visibility, branch protection, auto-merge, write collaborators and apps). The runner re-probes them before every autonomous merge and when it starts; the slower ones (CI jobs, test tooling) are only probed at onboarding.

**Hand merge**: The owner merging the onboarding PR, or a later change to a protected file, themselves. The runner never merges these. A hand merge of the onboarding PR is what moves the project off pr-only: the runner then records the pins.

**Policy drift**: A re-probe that no longer matches the facts snapshot. The runner re-probes the cheap facts and checks the pins before every autonomous merge and when it starts. Drift pauses autonomous merge in that project and opens Needs you with the diff; merging resumes only once the human has dealt with that ticket, and drift that is still there pauses it again, so the human re-agrees the policy or undoes the change. The workflow never adapts silently.

**Self-run enforcement**: The runner, not the code host, enforcing a merge policy's gates, backed by compensating controls (sole merger, head-SHA re-check, post-merge watch of the default branch).

**Post-merge watch**: After an autonomous merge the runner watches the required jobs on the merge commit on the default branch. A red one pauses the project's merges and opens Needs you with the merge SHA, the failing job and a revert PR that abt opens and never merges.

**Verification**: Evidence, gathered by the agent, that a change works: tests, e2e, visual regression, screenshots of the running app, and CI.

**Escalation**: The agent stopping to ask the human for a confirmation or decision, because the risk of continuing alone is too high. It sets the ticket to Needs you, posts one ask-point comment and rings the doorbell. Silence is never consent: a timeout only sends a reminder, which rings the doorbell again.

**Doorbell**: What tells the human a ticket needs them. It is the tracker's own notification of the ask-point comment, which carries that comment's text. An out-of-band push can be added alongside it; that push is content-free (the ticket and its link only). The doorbell only says "look": the ticket's comments carry the question and the reply.

**Owner reply**: A comment from the ticket's owner on a Needs you ticket, the only comments the runner acts on. The vocabulary is fixed: answer (a bare "yes" accepts the recommendation), abandon, re-run, raise tier. Anything else is logged as a note and does not resume the ticket.

**Routing**: Choosing the model family and thinking effort for a unit of work from its complexity grade, done by the runner when it dispatches the worker; the launch profile turns the family into a pinned model ID. Sonnet is the default; Opus is for hard work.

**Complexity grade**: How hard a ticket is to get right: simple, standard or hard. Each grade maps to one model and effort pair. Distinct from risk. Set by rule floors plus a judge that can only raise it, and it rises one step when a worker fails repeatedly.

**Judge**: A model that classifies one thing the rules cannot settle, such as a ticket's risk tier or complexity grade, and can only raise the rule floor's result, never lower it. A behavior tree can also use a judge as a condition.

**Worker worktree**: The isolated checkout a single worker agent works in, tied to exactly one ticket and one branch for the life of that run.

**Isolation lane**: The number a worker's worktree holds while it exists, from which its own ports, database and build output are derived (as the adapter doc says), so parallel workers' real-app verification never collides. Not a worker slot: a waiting ticket keeps its lane.

**Branch upkeep**: After a landing, the runner rebasing each other open worker branch onto the new default branch in its worktree and pushing it with a lease. A conflict goes back to the worker, then to the human if the worker cannot resolve it.

**Kept worktree**: A failed run's worker worktree, kept for a time (7 days by default) so the human can look at it, then removed. A worktree with uncommitted work is never removed; it is reported to the human.

**Skill**: A storage format only: a folder with a `SKILL.md` (name, description, body) that a harness can load. Procedures are stored as skills; the word says how something is kept, never what it is.

**Rule**: An always-loaded instruction in a plain markdown file, such as a project's `CLAUDE.md` or the human's user rules. It has no trigger and nothing enforces it; it is advice the agent reads. What must hold is a check, a gate or a pin, not a rule.

**Principle**: A single-rule coding or verification constraint the agent follows, stored as a plain file under `principles/` with a "when to apply" trigger and read by path, never registered as a skill. It constrains how code is written and checked, never a process. Advisory like a rule, but read only when its trigger fires.

**Principle index**: The short always-loaded list of every principle's name and trigger, delivered to workers through an appended system-prompt file, never through a project's `CLAUDE.md`. An agent reads a principle's file only when its trigger fires.

**Procedure**: A multi-step process for one kind of task, with a goal, ordered steps and an exit, stored as a skill file that is hidden from the human's command menu, so the runner starts a worker on it by name. A behavior tree's agent action hands one to a worker as its task input. There is one version of each, never a separate worker copy: where it would ask the human, a worker raises an ask-point instead. It is how, step by step; a principle is only a constraint on how the steps are done.

**Command**: A skill the human invokes by name in an interactive session to start something, such as enqueueing a ticket. It is often a thin wrapper that runs a procedure with the human, and the commands are the only skills in the `/abt:` menu. The runner starting a worker on a procedure is not a command.

**Provenance map**: The record, per forked skill, of where it came from (upstream repo and path, pinned commit, license), whether it is verbatim, modified or original, and how it diverges. It lets an agent diff against upstream later.

**Risk**: How costly it would be if a change were wrong. Distinct from complexity, which is how hard the change is to get right.

**Risk tier**: The level of risk assigned to a ticket: low, medium or high. It decides how far the agent may go without the human. It only ever rises during a run.

**Risk floor**: The minimum risk tier set by deterministic rules (what a change touches, its size, its verification coverage). No judgement may place a change below it.

**Risk map**: The per-project list of what raises the risk floor there (paths, file types, size threshold). Part of the merge policy.

**Ask-point**: A moment where an agent would ask the human: the question, its recommended answer, the evidence, and whether the choice is reversible. The risk tier decides whether it is decided and logged or escalated. A worker never blocks on the human: it records the ask-point open, without a handling, and hands back. On the next pass the runner settles it at the ticket's tier: decided, it writes the settled record that supersedes the open one and resumes the worker with the recommended answer; escalated, the ticket goes to Needs you and the worker resumes on the owner's reply. A worker may add `raisesTo`, the tier its recommendation would reach; it can only cause an escalation.

**Decision record**: One entry stating a single decision or outcome in a ticket's run (a tree node's result, a risk assessment, a routing choice, an ask-point, an override, a retype, an escalation, a merge, a probe, a pivot, or a note), why it was made, and a pointer to its evidence. Never edited; a wrong record is corrected by a later one that supersedes it.

**Decision log**: The append-only sequence of a ticket's decision records, read live and in post-hoc review. Reviewing it is how the human audits a run; there is no separate audit trail.

**Pivot**: An agent abandoning an approach it had started for a different one, recorded with what triggered it.

**Covered check**: A committed check, already on the default branch, that would fail if the touched surface broke. A source file is paired with its covered check by naming convention (a sibling test that a required CI job runs), and the risk map can add explicit pairings; only an e2e spec on the touched route covers UI. Deleting or renaming a covering check voids the pairing.

**Evidence gap**: A touched surface with no covered check, or a required piece of evidence that is missing. A gap makes the change at least medium risk.

**Self-certification**: The agent's own new tests or baselines counting as evidence for its own PR. Never allowed; they count only after a human has merged them.

**Bootstrap ticket**: A separate ticket, of its own work type, that adds missing verification tooling to a project. It is medium risk at minimum and needs human approval; the ticket that exposed the gap is capped at medium until it merges.

**Spec**: The written statement of what one change must do, with acceptance criteria that each name the covered check proving them. It sits between the ticket and the implementation, and lives on the tracker.

**Spec skip**: Going from ticket straight to implementation with the ticket body serving as the spec. Allowed only when the change is low risk, its touched surface is covered and its grade is not hard. Always logged, never silent.

**Spec approval**: The owner's yes to a spec, tied to the ticket's risk. Medium: given at the PR, which links the spec. High: the ticket stops in Needs you until the owner replies, and the ticket's foreseeable ask-points are batched into that one approval; no implementation worker starts before it. Low: none, since a low, covered ticket skips the spec.

**abt**: Short for agentic behavior tree, the name of this workflow and its repo. Everything it owns, in a project or globally, sits under an `abt/` folder so it is recognisable.

**Pin**: A recorded fingerprint of one of a project's protected abt files (merge policy, facts snapshot, adapter doc, trees, check scripts), kept outside the project so it can't be changed together with the file it guards. A file that no longer matches its pin stops the runner for that project until the human looks. Pins move only when the human merges a change to the file, or re-pins after reading it.

**Pinned install**: The fixed release of abt that the runner and its workers run, separate from any copy being edited. It changes only on an explicit upgrade, and the human's own sessions use the same release.

**Land tree**: The behavior tree that decides whether a verified PR merges. The merge policy is agreed with one specific land tree; a different one blocks merging and sends the ticket to Needs you.

**Runner-merge**: The one way a PR gets merged, whenever an autonomous merge is allowed: the runner re-checks the PR right before merging and only merges the exact commit it checked. No tree can merge any other way.
