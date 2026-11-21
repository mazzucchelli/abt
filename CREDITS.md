# Credits

abt ships files adapted from two MIT-licensed upstreams. A consumer installs abt only. Each file keeps the upstream license notice. Pins are "the copy we took", not "latest"; syncing is a deliberate ticket, never automatic.

| Upstream | Repo | Pinned SHA | License |
| --- | --- | --- | --- |
| Matt Pocock skills | `mattpocock-skills` 1.3.1 (claude-plugins-official) | `49dd158d1076134a641b33efb035946536778336` | MIT, Matt Pocock |
| pstack | https://github.com/cursor/plugins/tree/main/pstack 0.15.46 | `0b46ec399d55f2829e88822998f53b84944837d3` | MIT, Lauren Tan |

Actions: **verbatim** (matches upstream at the pin; a test enforces it), **adapted** (edited; divergence noted per file), **original**.

Precedence: project `CLAUDE.md`, then principles, then generic skill advice. A deviation is named.

| abt file | Upstream | Action | Divergence |
| --- | --- | --- | --- |
| `principles/attack-the-premise.md` | pstack@0b46ec3 principle-attack-the-premise | adapted | PREVIEW: filled in when the file lands |
| `principles/boundary-discipline.md` | pstack@0b46ec3 principle-boundary-discipline | adapted | PREVIEW: filled in when the file lands |
| `principles/build-the-lever.md` | pstack@0b46ec3 principle-build-the-lever | adapted | PREVIEW: filled in when the file lands |
| `principles/encode-lessons-in-structure.md` | pstack@0b46ec3 principle-encode-lessons-in-structure | adapted | PREVIEW: filled in when the file lands |
| `principles/explain-the-number.md` | pstack@0b46ec3 principle-explain-the-number | adapted | PREVIEW: filled in when the file lands |
| `principles/fix-root-causes.md` | pstack@0b46ec3 principle-fix-root-causes | adapted | PREVIEW: filled in when the file lands |
| `principles/foundational-thinking.md` | pstack@0b46ec3 principle-foundational-thinking | adapted | PREVIEW: filled in when the file lands |
| `principles/laziness-protocol.md` | pstack@0b46ec3 principle-laziness-protocol | adapted | PREVIEW: filled in when the file lands |
| `principles/make-operations-idempotent.md` | pstack@0b46ec3 principle-make-operations-idempotent | adapted | PREVIEW: filled in when the file lands |
| `principles/minimize-reader-load.md` | pstack@0b46ec3 principle-minimize-reader-load | adapted | PREVIEW: filled in when the file lands |
| `principles/model-the-domain.md` | pstack@0b46ec3 principle-model-the-domain | adapted | PREVIEW: filled in when the file lands |
| `principles/prove-it-works.md` | pstack@0b46ec3 principle-prove-it-works | adapted | PREVIEW: filled in when the file lands |
| `principles/separate-before-serializing-shared-state.md` | pstack@0b46ec3 principle-separate-before-serializing-shared-state | adapted | PREVIEW: filled in when the file lands |
| `principles/sequence-verifiable-units.md` | pstack@0b46ec3 principle-sequence-verifiable-units | adapted | PREVIEW: filled in when the file lands |
| `principles/subtract-before-you-add.md` | pstack@0b46ec3 principle-subtract-before-you-add | adapted | PREVIEW: filled in when the file lands |
| `principles/test-behavior-not-implementation.md` | pstack@0b46ec3 principle-test-behavior-not-implementation | adapted | PREVIEW: filled in when the file lands |
| `principles/type-system-discipline.md` | pstack@0b46ec3 principle-type-system-discipline | adapted | PREVIEW: filled in when the file lands |
| `principles/adr-worthiness.md` | `mattpocock-skills`@49dd158 domain-modeling (ADR three-part test) | adapted | PREVIEW: filled in when the file lands |
| `principles/deletion-test.md` | `mattpocock-skills`@49dd158 codebase-design (deletion test) | adapted | PREVIEW: filled in when the file lands |
| `procedures/implement/SKILL.md` | `mattpocock-skills`@49dd158 implement | adapted | PREVIEW: filled in when the file lands |
| `procedures/tdd/SKILL.md` | `mattpocock-skills`@49dd158 tdd | adapted | PREVIEW: filled in when the file lands |
| `procedures/code-review/SKILL.md` | `mattpocock-skills`@49dd158 code-review | adapted | PREVIEW: filled in when the file lands |
| `procedures/diagnosing-bugs/SKILL.md` | `mattpocock-skills`@49dd158 diagnosing-bugs; pstack@0b46ec3 playbooks/bug-fix | adapted | PREVIEW: filled in when the file lands |
| `procedures/research/SKILL.md` | `mattpocock-skills`@49dd158 research; pstack@0b46ec3 playbooks/investigation | verbatim | PREVIEW: filled in when the file lands |
| `procedures/spike/SKILL.md` | `mattpocock-skills`@49dd158 prototype; pstack@0b46ec3 playbooks/prototype | adapted | PREVIEW: filled in when the file lands |
| `procedures/pr/SKILL.md` | `mattpocock-skills`@49dd158 pr; pstack@0b46ec3 playbooks/opening-a-pr | verbatim | PREVIEW: filled in when the file lands |
| `procedures/refactoring/SKILL.md` | pstack@0b46ec3 playbooks/refactoring | adapted | PREVIEW: filled in when the file lands |
| `procedures/setup-pre-commit/SKILL.md` | `mattpocock-skills`@49dd158 setup-pre-commit | adapted | PREVIEW: filled in when the file lands |
| `procedures/setup-ts-deep-modules/SKILL.md` | `mattpocock-skills`@49dd158 setup-ts-deep-modules | adapted | PREVIEW: filled in when the file lands |
| `procedures/grilling/SKILL.md` | `mattpocock-skills`@49dd158 grilling | adapted | PREVIEW: filled in when the file lands |
| `procedures/domain-modeling/SKILL.md` | `mattpocock-skills`@49dd158 domain-modeling | adapted | PREVIEW: filled in when the file lands |
| `procedures/to-spec/SKILL.md` | `mattpocock-skills`@49dd158 to-spec | adapted | PREVIEW: filled in when the file lands |
| `procedures/to-tickets/SKILL.md` | `mattpocock-skills`@49dd158 to-tickets | adapted | PREVIEW: filled in when the file lands |
| `procedures/triage/SKILL.md` | `mattpocock-skills`@49dd158 triage | adapted | PREVIEW: filled in when the file lands |
| `commands/grill.md` | original (wraps procedures/grilling) | original | PREVIEW: filled in when the file lands |
| `commands/domain-model.md` | original (wraps procedures/domain-modeling) | original | PREVIEW: filled in when the file lands |
| `commands/to-spec.md` | original (wraps procedures/to-spec) | original | PREVIEW: filled in when the file lands |
| `commands/to-tickets.md` | original (wraps procedures/to-tickets) | original | PREVIEW: filled in when the file lands |
| `commands/triage.md` | original (wraps procedures/triage) | original | PREVIEW: filled in when the file lands |
| `reference/codebase-design.md` | `mattpocock-skills`@49dd158 codebase-design | adapted | PREVIEW: filled in when the file lands |
| `reference/writing-for-agents.md` | `mattpocock-skills`@49dd158 writing-for-agents; pstack@0b46ec3 playbooks/authoring-a-skill | verbatim | PREVIEW: filled in when the file lands |
| `reference/experience-first.md` | pstack@0b46ec3 principle-experience-first | adapted | PREVIEW: filled in when the file lands |
