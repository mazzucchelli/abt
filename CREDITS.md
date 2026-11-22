# Credits

abt ships files adapted from two MIT-licensed upstreams. A consumer installs abt only. Each file keeps the upstream license notice. Pins are "the copy we took", not "latest"; syncing is a deliberate ticket, never automatic.

| Key | Repo | Pinned SHA | License |
| --- | --- | --- | --- |
| `mattpocock-skills` | Matt Pocock skills 1.3.1 (claude-plugins-official); paths relative to the plugin root | `49dd158d1076134a641b33efb035946536778336` | MIT, Matt Pocock |
| `pstack` | https://github.com/cursor/plugins (paths from the repo root), pstack 0.15.46 | `0b46ec399d55f2829e88822998f53b84944837d3` | MIT, Lauren Tan |

Actions: **verbatim** (matches upstream at the pin; a test enforces it), **adapted** (edited; divergence noted per file), **original**.

Precedence: project `CLAUDE.md`, then principles, then generic skill advice. A deviation is named.

| abt file | Upstream | Action | Divergence |
| --- | --- | --- | --- |
| `commands/enqueue.md` | original | original | Original. Dispatches work to the runner. |
| `commands/grill-with-docs.md` | `mattpocock-skills`@49dd158 skills/engineering/grill-with-docs/SKILL.md | adapted | Runs procedures/grilling and procedures/domain-modeling together with the human, by path instead of two Skill calls; replaces separate grill and domain-model commands. |
| `commands/onboard.md` | original | original | Original. Drives the `abt onboard` CLI with the human to agree a merge policy; wraps no procedure, like enqueue. |
| `commands/to-spec.md` | original | original | Original. Thin wrapper that runs procedures/spec-writing with the human. |
| `commands/to-tickets.md` | original | original | Original. Thin wrapper that runs procedures/ticket-splitting with the human. |
| `commands/triage.md` | original | original | Original. Thin wrapper that runs procedures/triaging with the human. |
| `principles/adr-worthiness.md` | `mattpocock-skills`@49dd158 skills/engineering/domain-modeling/ADR-FORMAT.md | adapted | The three-part test extracted as a standalone principle. |
| `principles/attack-the-premise.md` | `pstack`@0b46ec3 pstack/skills/principle-attack-the-premise/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/boundary-discipline.md` | `pstack`@0b46ec3 pstack/skills/principle-boundary-discipline/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/build-the-lever.md` | `pstack`@0b46ec3 pstack/skills/principle-build-the-lever/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. Dropped the fan-out and delegate-skill lines (a worker works alone). |
| `principles/deletion-test.md` | `mattpocock-skills`@49dd158 skills/engineering/codebase-design/SKILL.md | adapted | The deletion test extracted as a standalone principle. |
| `principles/encode-lessons-in-structure.md` | `pstack`@0b46ec3 pstack/skills/principle-encode-lessons-in-structure/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/explain-the-number.md` | `pstack`@0b46ec3 pstack/skills/principle-explain-the-number/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. Dropped the benchmark-checklist link (performance work is deferred). |
| `principles/fix-root-causes.md` | `pstack`@0b46ec3 pstack/skills/principle-fix-root-causes/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/foundational-thinking.md` | `pstack`@0b46ec3 pstack/skills/principle-foundational-thinking/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/index.md` | original | original | Original. Precedence rule added; never-block-on-the-human left out (it becomes an ask-point rule in the tree and merge-policy design). |
| `principles/laziness-protocol.md` | `pstack`@0b46ec3 pstack/skills/principle-laziness-protocol/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/make-operations-idempotent.md` | `pstack`@0b46ec3 pstack/skills/principle-make-operations-idempotent/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/minimize-reader-load.md` | `pstack`@0b46ec3 pstack/skills/principle-minimize-reader-load/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/model-the-domain.md` | `pstack`@0b46ec3 pstack/skills/principle-model-the-domain/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/prove-it-works.md` | `pstack`@0b46ec3 pstack/skills/principle-prove-it-works/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. Output goes to the PR description or decision log, not to a human watching. |
| `principles/separate-before-serializing-shared-state.md` | `pstack`@0b46ec3 pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/sequence-verifiable-units.md` | `pstack`@0b46ec3 pstack/skills/principle-sequence-verifiable-units/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/subtract-before-you-add.md` | `pstack`@0b46ec3 pstack/skills/principle-subtract-before-you-add/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/test-behavior-not-implementation.md` | `pstack`@0b46ec3 pstack/skills/principle-test-behavior-not-implementation/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. |
| `principles/type-system-discipline.md` | `pstack`@0b46ec3 pstack/skills/principle-type-system-discipline/SKILL.md | adapted | Frontmatter dropped; trigger moved to a When to apply line. Dropped the pointer to the typescript-best-practices skill (not shipped). |
| `procedures/code-review/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/code-review/SKILL.md | adapted | Frontmatter hidden. Setup pointer replaced by the project's `docs/agents/`; added the fallback of running the two axes in turn when a worker has no sub-agent tool. |
| `procedures/diagnosing-bugs/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/diagnosing-bugs/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/bug-fix.md | adapted | Frontmatter hidden. HITL script option replaced by an ask-point. Added Shipping the fix, folded from the bug-fix playbook (evidence rule, same-surface verify, failing repro first). |
| `procedures/domain-modeling/ADR-FORMAT.md` | `mattpocock-skills`@49dd158 skills/engineering/domain-modeling/ADR-FORMAT.md | verbatim |  |
| `procedures/domain-modeling/GLOSSARY-FORMAT.md` | `mattpocock-skills`@49dd158 skills/engineering/domain-modeling/GLOSSARY-FORMAT.md | verbatim |  |
| `procedures/domain-modeling/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/domain-modeling/SKILL.md | adapted | Frontmatter hidden. |
| `procedures/grilling/SKILL.md` | `mattpocock-skills`@49dd158 skills/productivity/grilling/SKILL.md | adapted | Frontmatter hidden. Fact-finding by sub-agent is optional for a worker. |
| `procedures/implement/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/implement/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/feature.md | adapted | Frontmatter: `user-invocable: false`. Skill names are `abt:`-prefixed. Added a How section folded from the feature playbook; dropped its throughput checkpoint, persona and delegation (a worker runs alone). |
| `procedures/pr/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/pr/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/opening-a-pr.md | adapted | Frontmatter hidden, credits metadata dropped. Added Opening it (title convention, stacking, ready not draft) from the opening-a-pr playbook; pstack's body headings not adopted, the Matt template stays. |
| `procedures/research/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/research/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/investigation.md | adapted | Frontmatter hidden. Added the no-sub-agent fallback and an Investigations section folded from the investigation playbook (read-only, output outline, no PR). |
| `procedures/setup-pre-commit/SKILL.md` | `mattpocock-skills`@49dd158 skills/misc/setup-pre-commit/SKILL.md | adapted | Frontmatter hidden. |
| `procedures/setup-ts-deep-modules/SKILL.md` | `mattpocock-skills`@49dd158 skills/in-progress/setup-ts-deep-modules/SKILL.md | adapted | Frontmatter hidden. `codebase-design` is read as a reference file. |
| `procedures/setup-ts-deep-modules/dependency-cruiser.config.cjs` | `mattpocock-skills`@49dd158 skills/in-progress/setup-ts-deep-modules/dependency-cruiser.config.cjs | verbatim |  |
| `procedures/spec-writing/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/to-spec/SKILL.md | adapted | Renamed from to-spec so its skill name differs from the `/abt:to-spec` command. Frontmatter hidden. Setup pointer replaced by the project's `docs/agents/`. |
| `procedures/spike/LOGIC.md` | `mattpocock-skills`@49dd158 skills/engineering/prototype/LOGIC.md | verbatim |  |
| `procedures/spike/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/prototype/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/prototype.md | adapted | Renamed from prototype; frontmatter hidden. Added Spike rules folded from the prototype playbook (scope the decision, switcher, verify on the surface, recommend). |
| `procedures/spike/UI.md` | `mattpocock-skills`@49dd158 skills/engineering/prototype/UI.md | verbatim |  |
| `procedures/tdd/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/tdd/SKILL.md | adapted | Frontmatter hidden. `codebase-design` is read as a reference file, not a Skill call; `code-review` is `abt:code-review`. |
| `procedures/tdd/mocking.md` | `mattpocock-skills`@49dd158 skills/engineering/tdd/mocking.md | verbatim |  |
| `procedures/tdd/tests.md` | `mattpocock-skills`@49dd158 skills/engineering/tdd/tests.md | verbatim |  |
| `procedures/ticket-splitting/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/to-tickets/SKILL.md | adapted | Renamed from to-tickets so its skill name differs from the `/abt:to-tickets` command. Frontmatter hidden. Setup pointer replaced by the project's `docs/agents/`. |
| `procedures/triaging/AGENT-BRIEF.md` | `mattpocock-skills`@49dd158 skills/engineering/triage/AGENT-BRIEF.md | verbatim |  |
| `procedures/triaging/OUT-OF-SCOPE.md` | `mattpocock-skills`@49dd158 skills/engineering/triage/OUT-OF-SCOPE.md | verbatim |  |
| `procedures/triaging/SKILL.md` | `mattpocock-skills`@49dd158 skills/engineering/triage/SKILL.md | adapted | Renamed from triage so its skill name differs from the `/abt:triage` command. Frontmatter hidden. Setup pointer replaced by `docs/agents/`; grilling and domain-modeling are called as `abt:`-prefixed. |
| `reference/SKILL-MECHANICS.md` | `mattpocock-skills`@49dd158 skills/productivity/writing-for-agents/SKILL-MECHANICS.md | adapted | Links point at writing-for-agents.md, not SKILL.md. |
| `reference/codebase-design.md` | `mattpocock-skills`@49dd158 skills/engineering/codebase-design/SKILL.md | adapted | Dropped the Going deeper section and its two sibling files (DEEPENING, DESIGN-IT-TWICE): the first belongs to improve-codebase-architecture (ABT-83), the second needs parallel sub-agents. |
| `reference/experience-first.md` | `pstack`@0b46ec3 pstack/skills/principle-experience-first/SKILL.md | adapted | Frontmatter dropped; kept as a reference, not a principle (no trigger line). |
| `reference/writing-for-agents.md` | `mattpocock-skills`@49dd158 skills/productivity/writing-for-agents/SKILL.md; `pstack`@0b46ec3 pstack/skills/poteto-mode/playbooks/authoring-a-skill.md | adapted | Added Authoring a skill, folded from the authoring-a-skill playbook. |

## Reviewed playbooks

pstack's 22 playbooks, read at the pin. One line each: where it went and why.

- bug-fix: folded into procedures/diagnosing-bugs. Reproduce, binary-search to a mechanism with runtime evidence, ship the smallest justified fix, verify on the same surface, land the failing repro first.
- feature: folded into procedures/implement. Trace, settle the shape, verify on the matching surface, commit in small units; the throughput checkpoint is dropped because a worker runs alone.
- investigation: folded into procedures/research. Read-only trace that returns a cited overview or a tradeoffs recommendation, no PR.
- prototype: folded into procedures/spike. Scope one decision, build labelled variants behind a switcher, verify each on its surface, recommend.
- opening-a-pr: folded into procedures/pr. Title convention, stack follow-ups, open ready not draft; its 40-line body headings are not adopted because the Matt template stays.
- authoring-a-skill: folded into reference/writing-for-agents.md. Validate frontmatter and links, test structural skills, cut prose that changes no decision.
- refactoring: not shipped. No work type, tree or command reaches it; restorable from git history.
- autopilot-full: not shipped, runner-owned. One owner per PR, a verifier swarm and merges of proven work are the runner's job.
- autopilot-stack: not shipped, runner-owned. Stacking dependent PRs and stopping at verified belongs to the runner's landing.
- babysit: not shipped, runner-owned. Driving a PR's conflicts, reviews and CI to merge-ready is the runner's upkeep.
- shipping: not shipped, runner-owned. Independent verification and bottom-up landing are the merge policy's gates.
- autonomous-run: not shipped, runner-owned. The loop driver with an exit predicate is the runner's pass loop.
- pause-safely: not shipped, runner-owned. Clean stop and resume note are the runner's resume of a parked worker.
- session-pickup: not shipped, runner-owned. Reconstructing a prior session is the runner's dispatch state and decision log.
- worktree-cleanup: not shipped, runner-owned. Pruning worktrees is the runner's worktree hygiene.
- multi-phase-plan: not shipped, runner-owned. Planning PR order and dependencies is a behavior tree and blocker edges, not a worker skill.
- perf-issue: deferred. Baseline, fix and compare with a measured number; performance work gets its own ticket.
- visual-parity: deferred. Pixel-diff migration needs a visual baseline tool abt does not have yet.
- eval: deferred. Blinded experiment design belongs with an eval work type, not this layout.
- hillclimb: deferred. One-change-one-measurement loops against a frozen harness wait for a measurement work type.
- runtime-forensics: deferred. Live-process capture (CPU profile, heap snapshot) wait for the forensics tickets.
- trace-forensics: deferred. Attributing a hot frame from a fixed profile artifact waits for the forensics tickets.

## Review against the runner's checks

The checks a worker runs under: `dontAsk` with a fixed allowlist (no push, merge or branch switch, no sub-agent tool), no human present (an ask becomes an ask-point), and the tree's feedback commands. A file passes, passes after the adaptation noted in its row, or is dropped.

Procedures:

- implement: passes after adaptation (abt-prefixed skill calls; the runner opens the PR).
- tdd: passes; unconfirmed seams become ask-points.
- code-review: passes after adaptation (axes run in turn without a sub-agent tool).
- diagnosing-bugs: passes after adaptation (HITL script replaced by an ask-point).
- research: passes after adaptation (no background agent needed).
- spike: passes; the human review happens on the PR.
- pr: passes; the worker writes the body, the runner opens the PR.
- setup-pre-commit: passes; installs need the tree's feedback commands to allow them.
- setup-ts-deep-modules: passes; the "confirm the packages root" step becomes an ask-point.
- grilling: passes; every question to the human becomes an ask-point, so a worker gets value only from the fact-finding half.
- domain-modeling: passes; term questions become ask-points.
- spec-writing: passes after adaptation (tracker config from `docs/agents/`).
- ticket-splitting: passes after adaptation; approval rounds become ask-points.
- triaging: passes after adaptation; "wait for direction" becomes an ask-point.

Principles: all 19 shipped ones pass; build-the-lever, explain-the-number, prove-it-works and type-system-discipline needed the edits in their rows.

Dropped:

- `principle-never-block-on-the-human`: becomes the ask-point rule (glossary: Ask-point) for the tree and merge-policy design.
- `principle-guard-the-context-window`, `principle-exhaust-the-design-space`, `principle-outcome-oriented-execution`, `principle-redesign-from-first-principles`, `principle-migrate-callers-then-delete-legacy-apis`: not adopted in the unified table's first pass (orchestration or interactive design advice; the last is not covered by a shipped procedure).
- `codebase-design` DEEPENING.md and DESIGN-IT-TWICE.md: DEEPENING belongs with improve-codebase-architecture (ABT-83); DESIGN-IT-TWICE needs parallel sub-agents.
- `diagnosing-bugs` `scripts/hitl-loop.template.sh`: a worker has no human at the keyboard.
