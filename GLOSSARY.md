# Glossary

Domain terms for the AI workflow. Definitions only, no implementation detail.

**Entry point**: The way the human starts one or more activities, typically a command in a Claude Code or opencode chat, usually with a ticket.

**Primary agent**: The single conversational agent that receives work from every entry point, knows how to react to each, prepares the ticket and hands it to the runner. It never evaluates a gate.

**Runner**: The deterministic program that runs a ticket's behavior tree, executes its checks and spawns worker agents for its agent actions. It holds dispatch state only and enforces the invariants no tree can remove.

**Pass**: One run of a ticket's behavior tree from the root. A pass happens when the ticket's worker ends, when the primary agent nudges the runner, or on a regular poll.

**Worker slot**: Permission for one worker agent to be running. Slots are shared across all projects on a machine, with an optional lower cap per project, and only a running worker holds one: a ticket waiting on CI, an approval, a blocker or the human holds none.

**Behavior tree**: The definition of how one work type moves from ticket to done: a tree of conditions (facts read from the world) and actions, re-run from the root on every pass, with no state stored inside it.

**Work type**: The kind of a ticket (for example implement or research), chosen at intake; it selects which behavior tree runs. There are four: implement (ends in a merged PR), research (ends in a doc, no code), spike (throwaway code that answers a question, never merged; prototypes are spikes with a human in the loop) and bootstrap (adds missing verification tooling). A ticket has exactly one.

**Lifecycle state**: The coarse, human-visible state of a ticket in the tracker: Todo, In progress, In review, Needs you, Done or Abandoned.

**Harness**: The agent program a worker runs inside (for example Claude Code, opencode or Codex). Behavior trees never name one.

**Harness adapter**: The part of the runner that turns a harness-neutral agent action into a run of one specific harness, and reports back how it ended.

**Launch profile**: The mapping from a harness-neutral agent action to the actual command that starts a worker: which harness, which account or gateway, and which model and effort each complexity grade uses.

**Worker agent**: An agent dispatched by the runner to carry out one unit of work, running at the model and effort the routing chose.

**Autonomous merge**: An agent merging its own PR into the default branch after every gate in the project's agreed merge policy has passed. A human approval can be one of those gates; the no-human case is the policy with zero required approvals. Never a direct push.

**Merge policy**: The per-project agreement, made when the workflow is first initiated there, of which gates must pass before an autonomous merge (checks, human approvals, enforcement mode, compensating controls, risk cap), or that the agent never merges. Without one, the agent does not merge.

**Merge-policy preset**: A ready-made starting merge policy that onboarding proposes from a project's probed facts: pr-only (the fallback), solo-self, solo-server or team-reviewed. The human edits it before agreeing.

**Onboarding**: The conversation in which the workflow first meets a project: it probes the project's facts, proposes a preset and a risk map, and ends with the human agreeing to a merge policy. Until then the project is pr-only.

**Facts snapshot**: The probed project facts (enforcement, required checks, writers, CI jobs, test tooling) that a merge policy was agreed against.

**Policy drift**: A re-probe that no longer matches the facts snapshot. It pauses autonomous merge in that project until the human re-agrees; the workflow never adapts silently.

**Self-run enforcement**: The runner, not the code host, enforcing a merge policy's gates, backed by compensating controls (sole merger, head-SHA re-check, post-merge watch of the default branch).

**Verification**: Evidence, gathered by the agent, that a change works: tests, e2e, visual regression, screenshots of the running app, and CI.

**Escalation**: The agent stopping to ask the human for a confirmation or decision, because the risk of continuing alone is too high.

**Routing**: Choosing the model and thinking effort for a unit of work from its complexity grade, done by the runner when it dispatches the worker. Sonnet is the default; Opus is for hard work.

**Complexity grade**: How hard a ticket is to get right: simple, standard or hard. Each grade maps to one model and effort pair. Distinct from risk. Set by rule floors plus a judge that can only raise it, and it rises one step when a worker fails repeatedly.

**Worker worktree**: The isolated checkout a single worker agent works in, tied to exactly one ticket and one branch for the life of that run.

**Landing strategy**: How a project lines up verified PRs to merge into the default branch, one after another. Chosen per project; the rest of the workflow does not change with it.

**Principle**: A single-rule coding or verification constraint the agent follows, stored as a small standalone skill file with a "when to apply" trigger. It constrains how code is written and checked, never a process.

**Principle index**: The short always-loaded list of every principle's name and trigger. An agent reads a principle's file only when its trigger fires.

**Provenance map**: The record, per forked skill, of where it came from (upstream repo and path, pinned commit, license), whether it is verbatim, modified or original, and how it diverges. It lets an agent diff against upstream later.

**Risk**: How costly it would be if a change were wrong. Distinct from complexity, which is how hard the change is to get right.

**Risk tier**: The level of risk assigned to a ticket: low, medium or high. It decides how far the agent may go without the human. It only ever rises during a run.

**Risk floor**: The minimum risk tier set by deterministic rules (what a change touches, its size, its verification coverage). No judgement may place a change below it.

**Risk map**: The per-project list of what raises the risk floor there (paths, file types, size threshold). Part of the merge policy.

**Ask-point**: A moment where an agent would ask the human: the question, its recommended answer, the evidence, and whether the choice is reversible. The risk tier decides whether it is decided and logged or escalated.

**Decision record**: One entry stating a single decision or outcome in a ticket's run (a tree node's result, a risk assessment, a routing choice, an ask-point, an override, a retype, an escalation, a merge, or a pivot), why it was made, and a pointer to its evidence. Never edited; a wrong record is corrected by a later one that supersedes it.

**Decision log**: The append-only sequence of a ticket's decision records, read live and in post-hoc review. Reviewing it is how the human audits a run; there is no separate audit trail.

**Pivot**: An agent abandoning an approach it had started for a different one, recorded with what triggered it.

**Covered check**: A committed check, already on the default branch, that would fail if the touched surface broke. The risk map pairs each surface with its covered check.

**Evidence gap**: A touched surface with no covered check, or a required piece of evidence that is missing. A gap makes the change at least medium risk.

**Self-certification**: The agent's own new tests or baselines counting as evidence for its own PR. Never allowed; they count only after a human has merged them.

**Bootstrap ticket**: A separate ticket, of its own work type, that adds missing verification tooling to a project. It is medium risk at minimum and needs human approval; the ticket that exposed the gap is capped at medium until it merges.

**Spec**: The written statement of what one change must do, with acceptance criteria that each name the covered check proving them. It sits between the ticket and the implementation, and lives on the tracker.

**Spec skip**: Going from ticket straight to implementation with the ticket body serving as the spec. Allowed only when the change is low risk, its touched surface is covered and its grade is not hard. Always logged, never silent.

**abt**: Short for agentic behavior tree, the name of this workflow and its repo. Everything it owns, in a project or globally, sits under an `abt/` folder so it is recognisable.

**Pin**: A recorded fingerprint of one of a project's protected abt files (merge policy, adapter doc, trees, check scripts), kept outside the project so it can't be changed together with the file it guards. A file that no longer matches its pin stops the runner for that project until the human looks. Pins move only when the human merges a change to the file.

**Pinned install**: The fixed release of abt that the runner and its workers run, separate from any copy being edited. It changes only on an explicit upgrade, and the human's own sessions use the same release.
