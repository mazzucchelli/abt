# Reading a decision log

Every ticket's decisions are in `$ABT_HOME/log/<ticket>.jsonl`, one JSON record per line, append-only. The record format is [`schema/decision-log.schema.json`](../../schema/decision-log.schema.json).

```bash
abt log show MP-12              # the latest run
abt log show MP-12 --run <id>   # one run
```

```
TIME                      NODE           KIND          RESULT   DECISION                                     WHY                       NOTE
2026-11-22T09:19:00.000Z  implement/2/0  routing       ok       route simple to claude-sonnet-5-5 at medium  second try
2026-11-22T09:20:00.000Z  implement/2/0  node-outcome  running  agent tdd                                    worker started
2026-11-22T09:21:00.000Z  implement/2/0  ask-point     ok       decided: rename CTA key                      low risk and reversible: decided by the recommendation
```

## Columns

| Column | Meaning |
| --- | --- |
| TIME | when the record was written |
| NODE | the tree node it belongs to ([node IDs](trees.md#node-ids)), or `-` for ticket-level records (risk, overrides, merges) |
| KIND | what kind of decision (below) |
| RESULT | `ok`, `fail`, `running`, `open`, `inconclusive`, `error` or `skipped` ([results](trees.md#results)) |
| DECISION | the decision in one line |
| WHY | the reason |
| NOTE | `supersedes <id>` or `superseded by <id>`, when a record corrects or was corrected by another |

Every record also carries an `id`; the log file has them, the table doesn't. To see a run other than the latest, take its id from the file (`$ABT_HOME/log/<ticket>.jsonl`, field `run`) and pass `--run`.

Every record also has an `evidence` pointer (a PR URL, a transcript path, a comment id) and a `run` id. One run is one runner pass over the ticket.

## Record kinds

| Kind | Written when |
| --- | --- |
| `node-outcome` | any tree node finishes or is skipped |
| `risk-assessment` | intake sets the risk tier: the rule floors, the judge's answer, the final tier |
| `routing` | before a worker launch: grade, model, effort, and why (floors, judge, step-ups) |
| `ask-point` | a worker raises a question (`open`), or the runner settles it (`decided` or `escalated`) |
| `escalation` | the ticket goes to Needs you, with what it needs from you |
| `override` | the owner's reply acts on the ticket: answer, abandon, re-run, raise tier, or ack on research |
| `retype` | you changed the work type |
| `probe` | a drift re-probe found a difference |
| `merge` | `runner-merge` merged a PR: SHA, policy hash, land tree hash |
| `pivot` | a worker abandoned an approach for another, and what triggered it |
| `blocked` | a worker found a dependency and released its slot |
| `note` | anything else worth keeping, such as a reply that wasn't a command |

## Auditing a merged ticket

To check that an autonomous merge was right, read the whole log and confirm the points below. The work and the landing happen in different runs, so either read `$ABT_HOME/log/<ticket>.jsonl` or call `abt log show --run` for each run.

1. **Tier.** The `risk-assessment` record: which rules set the floor, whether the judge raised it, the final tier. Low means every touched file was covered and nothing in the risk map applied.
2. **Spec.** The `check spec-ready` outcome: either a linked spec with every criterion mapped, or a logged spec skip.
3. **Routing.** The `routing` records: the grade, and any step-ups after failures.
4. **Questions.** `ask-point` records: each one decided or escalated, and why. Decided ones are also listed in the PR body.
5. **Landing.** `ci-check-green` names the head SHA it verified, `head-sha-unchanged` confirms it, `risk-within-cap` or `pr-approved` explains why no (or which) approval was needed.
6. **Merge.** The `merge` record pins the merged SHA, the policy hash and the land tree hash.

## Corrections

Records are never edited. A wrong or outdated record is corrected by a later one whose `supersedes` names it. For example, the runner settling a worker's open ask-point writes a new `ask-point` record that supersedes it. `retry` and `timeout` only count live (not superseded) records, and an owner override resets their counts.
