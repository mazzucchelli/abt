# Preview: skills layout

Throwaway branch. Stubs only; never merge.

## Resulting tree (new = stub in this branch, existing = already on main)

```
commands/                          the whole /abt: menu
  enqueue.md                       existing
  grill.md domain-model.md to-spec.md to-tickets.md triage.md      new
procedures/                        new; hidden skills, each a folder with SKILL.md
  implement tdd code-review diagnosing-bugs research spike pr refactoring
  setup-pre-commit setup-ts-deep-modules
  grilling domain-modeling to-spec to-tickets triage
principles/                        new
  index.md + 19 principle files
reference/                         new
  codebase-design.md writing-for-agents.md experience-first.md
defaults/trees/ docs/ src/ ...     existing, untouched (tdd-afk -> tdd comes with the ticket)
CREDITS.md GLOSSARY.md plugin.json rewritten / edited
```

The ticket text follows.

## What to build

Ship abt's skill content in one kind-first layout, so the folder says what a file is (glossary: principle, procedure, command; "skill" is only the storage format). Supersedes ABT-77 and absorbs ABT-78's library and ABT-79's playbook review. Decisions come from the grilling session on the unified table (Linear doc "skills and principles: unified table").

```
commands/          the whole /abt: menu: enqueue, grill, domain-model, to-spec, to-tickets, triage
procedures/        hidden skills the runner starts a worker on, one folder each with SKILL.md:
                   implement, tdd, code-review, diagnosing-bugs, research, spike, pr, refactoring,
                   setup-pre-commit, setup-ts-deep-modules, grilling, domain-modeling,
                   to-spec, to-tickets, triage
principles/        index.md + one plain file per principle (read by path, not registered)
reference/         codebase-design, writing-for-agents, experience-first
CREDITS.md         pins + one table: file, upstream, action, divergence
```

A throwaway branch `feature/skills-layout-preview` (local) holds this tree as stubs.

## Decisions

* **Three axes.** Kind = folder. Entry = who can start it: only `commands/` appear in the `/abt:` menu; procedures are `user-invocable: false`. Mode = may it ask a human: carried by the runner's worker context, never by the skill.
* **One procedure, no `-afk` forks, no `mode:` frontmatter.** Where a procedure would ask the human, a worker raises an ask-point; the risk tier decides decide-and-log versus escalate. A fork is allowed only if a procedure needs different steps for workers (none known).
* **Commands are thin.** A command is a human verb that runs a procedure with the user (`grill` runs `grilling`). Names differ from the procedure's to avoid a clash. Procedures used by a human and by a worker (grilling, domain-modeling, to-spec, to-tickets, triage) have both.
* **Runner launch change.** A hidden skill refuses `/abt:<name>` ("can only be invoked by Claude", verified), so `src/harness/claude/launch.ts` names the procedure in the worker prompt instead. `defaults/trees/implement.yaml` changes `tdd-afk` to `tdd`, with tests and docs examples.
* **plugin.json** lists each procedure folder in `skills`. Principles and references are plain files.
* **Four work types stay.** A prototype is a spike a human reviews (glossary unchanged). A fifth type is deferred to ABT-14.
* **No role-to-skill map**: the tree's `agent:` leaf names the procedure. Consumer swapping is out of scope.
* **Other human-only commands deferred** to ABT-83 (bro/wait-what, handoff, retro, teach, wayfinder, improve-codebase-architecture).
* **Scope** starts from the table's adopt/adapt/drop verdicts (first-pass); a file that fails review is dropped and noted. `never-block-on-the-human` leaves the index and becomes an ask-point rule in the tree and merge-policy design. The ADR three-part test and the deletion test become standalone principles.
* **Playbooks**: read pstack's 20 playbooks; fold the process-shaped parts into the matching procedure (bug-fix into diagnosing-bugs, feature into implement, investigation into research, prototype into spike, opening-a-pr into pr, authoring-a-skill into writing-for-agents); `refactoring` is the one candidate for a new procedure; runner-owned ones (autopilot-*, babysit, shipping, autonomous-run, pause-safely, session-pickup, worktree-cleanup, multi-phase-plan) are not shipped. Perf, visual-parity, eval, hillclimb and forensics playbooks are deferred. One line per playbook in the findings.
* **CREDITS.md simplified** to pins plus one table; the pin test covers `verbatim` rows only.
* **Precedence**: project CLAUDE.md, then principles, then generic skill advice.
* **Glossary**: Procedure and Command entries updated (hidden from the menu, one version, ask-point rule; commands are thin wrappers and the whole menu).

## Acceptance criteria

- [ ] The layout above exists; `plugin.json` registers every procedure and each loads in a worker
- [ ] Only `commands/` appear in the `/abt:` menu; procedures are hidden
- [ ] A worker is started on a hidden procedure by name, and a test covers `launch.ts`
- [ ] In a worker, a procedure that would ask the human raises an ask-point instead
- [ ] A worker launch includes the principle index through the appended system-prompt file
- [ ] A fixture where project CLAUDE.md conflicts with a principle shows CLAUDE.md winning, with the deviation named
- [ ] `defaults/trees/implement.yaml` and its tests use `tdd`, not `tdd-afk`
- [ ] A test checks every `verbatim` file matches upstream at its pin
- [ ] `CREDITS.md` has a row for every shipped file and one line per reviewed playbook
- [ ] Every principle and procedure is reviewed against the runner's checks; those that fail are dropped and noted
