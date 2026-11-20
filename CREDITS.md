# Credits

abt ships a skill tree built on top of two upstream projects. A consumer installs abt only; the upstreams are never a consumer concern. This file is the source of truth for what we took, from where, and how it diverges. It is the deliverable of ABT-64 (research and decision); the skills themselves land in follow-up tickets.

## Upstreams

| Upstream | Repo | Pinned SHA | Version | License | Copyright |
| --- | --- | --- | --- | --- | --- |
| Matt Pocock skills | `mattpocock-skills` plugin (claude-plugins-official) | `49dd158d1076134a641b33efb035946536778336` | 1.3.1 | MIT | Matt Pocock, 2026 |
| pstack | https://github.com/cursor/plugins/tree/main/pstack | `0b46ec399d55f2829e88822998f53b84944837d3` (last commit touching `pstack/`, 2026-11-19) | 0.15.46 | MIT (`pstack/LICENSE`; the repo root has none) | Lauren Tan, 2026 |

Every vendored file keeps its upstream license and copyright notice. The pinned SHA is "the copy we vendored", not "latest". Syncing is manual and deliberate (see Maintenance).

## Naming rule

- Plain name: interactive, for humans (`abt:grilling`), or safe for both (`mode: both`).
- `-afk` suffix: worker-only. A human should never invoke it (`abt:grilling-afk`). Applies to forks of an interactive original and to original or extracted skills that exist only for workers.
- Every skill carries `mode: interactive | afk | both` in its frontmatter. Every fork rewrites its description to say "AFK workers only" and sets `disable-model-invocation`.
- Workers are told skills by name at dispatch, through one role-to-skill mapping file.

## Actions

- **verbatim**: vendored copy, unedited, matches upstream at the pinned SHA (a test enforces this).
- **fork**: copied, edited, divergence recorded below.
- **extract**: a small piece of an upstream skill folded into a skill of our own; divergence is "partial".
- **original**: written by us; sources credited where they informed it.

## Matt Pocock skills

Shortlist of 13 shipped skills (of 38 audited). Rows marked `abt:<name>-afk` are new worker-only skills.

| abt skill | Upstream skill | Action | Mode | Divergence |
| --- | --- | --- | --- | --- |
| `grilling` | `grilling` | verbatim | interactive | none |
| `grill-me` | `grill-me` | verbatim | interactive | none (alias of grilling) |
| `grilling-afk` | `grilling` | fork | afk | Answers only from cited evidence; turns unanswerable questions into ask-points. |
| `domain-modeling` | `domain-modeling` | verbatim | interactive | none |
| `domain-modeling-afk` | `domain-modeling` | fork | afk | Writes glossary updates directly; drafts ADRs as "proposed". |
| `to-spec` | `to-spec` | verbatim | both | none. Already synthesis-only. |
| `to-tickets` | `to-tickets` | verbatim | interactive | none |
| `to-tickets-afk` | `to-tickets` | fork | afk | No interview; ticket splitting from a given spec. |
| `tdd` | `tdd` | verbatim | interactive | none |
| `tdd-afk` | `tdd` | fork | afk | Proposes seams from the acceptance criteria and records them in the PR description. |
| `code-review` | `code-review` | verbatim | interactive | none |
| `code-review-afk` | `code-review` | fork | afk | Reports a skipped Spec axis as "not verified". May absorb extracts from pstack `interrogate`. |
| `codebase-design` | `codebase-design` | verbatim | both | none |
| `diagnosing-bugs` | `diagnosing-bugs` | verbatim | both | none. Feedback-loop-first suits workers. |
| `research` | `research` | verbatim | both | none. Already agent-shaped. |
| `prototype` | `prototype` | verbatim | both | none. A worker may run it when the ticket states the design question; a human judges the result in the PR. |
| `pr` | `pr` | verbatim | interactive | none |
| `pr-afk` | `pr` | extract | afk | Merge-danger section and before/after evidence only. Partial. |
| `writing-for-agents` | `writing-for-agents` | verbatim | both | none. Skill-improvement tickets produce a PR for review. |

Extracts into our own skills, no verbatim copy shipped: `implement` and `implement-spec` (TDD, typecheck, review, commit loop; task-graph frontier), `triage` (state machine, agent-ready brief), `git-guardrails-claude-code` (destructive-git PreToolUse hook; overlaps the permission guard already in the runner). Each becomes a row here when its skill lands.

Not shipped (one line each): `wayfinder` and `chief-of-staff` (multi-session planning; the runner owns orchestration), `handoff` and `claude-handoff` (the runner handles handoff), `retro`, `ask-matt`, `setup-matt-pocock-skills`, `improve-codebase-architecture`, `wizard`, `teach`, `to-questionnaire`, `wait-what`, the `writing-*` skills, `loop-me`, `setup-ts-deep-modules`, and the misc tooling skills (`migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`). HITL-only, setup, or unrelated to workers.

## pstack

| abt skill | Upstream path | Action | Mode | Divergence |
| --- | --- | --- | --- | --- |
| principle library (about 24 leaves) | `skills/principle-*/SKILL.md` | fork | both | Each leaf reviewed and adapted to abt's checks; conflicting ones edited. Index always loaded. Own ticket. |
| `principle-never-block-on-the-human` | `skills/principle-never-block-on-the-human` | fork | afk | Reconciled with ask-points and risk tiers; the rule loosens over time as checks mature. |
| `show-me-your-work-afk` | `skills/show-me-your-work` | extract | afk | Decision-trail idea, adapted to the runner's audit log. Partial. |
| `interrogate` | `skills/interrogate` | extract | both | Adversarial-review checklist, folded into `code-review-afk`. Partial. |
| `blast-radius-afk` | `skills/blast-radius` | extract | afk | Cross-codebase impact check, proven by running code. Partial. |
| `correct-afk` | `skills/correct` | extract | afk | Turn repeated mistakes into structure. Partial. |

Deferred to a separate ticket (review against the runner's current prompts): the pstack playbooks (`bug-fix`, `feature`, `refactoring`, `opening-a-pr`, `investigation`) and `skills/poteto-mode/worker.md`.

Not shipped: `swarm`, `arena`, the `babysit` and `shipping` playbooks (the runner owns fan-out and merging); `tdd`, `unslop`, `technical-writing`, `typescript-best-practices` (overlap with Matt's `tdd` and existing writing tooling); the Benny automation, statechart toolchain, watch-pr, the guide and harness docs, `poteto-mode` itself (out of scope; we take ideas, not machinery).

Caveat: the pstack inventory was a skim. Frontmatter and line counts were read for every file, but several purposes were inferred from names. Re-read each source before forking it.

## Precedence

Project `CLAUDE.md` first, then principles, then generic skill advice. When a principle is overridden, the deviation is named.

## Maintenance

- No automatic sync. Re-syncing an upstream is a deliberate ticket with a diff review; a worker never picks up upstream changes silently.
- The sync and credits-audit skills are maintainer-only and live in this repo's `.claude/skills/`, not in the shipped plugin.
- A consumer-facing housekeeping skill is a separate, later ticket.
