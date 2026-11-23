---
tracker:
  kind: linear
  team: ABT
  # Credentials are referenced by name, never stored here: `keychain: item` or `env: VAR`.
  # The runner daemon only sees the Keychain, so use `keychain:` for any project it serves.
  credentials:
    keychain: abt-linear
  # Every lifecycle state must map to one of the team's state names.
  states:
    Todo: Todo
    In progress: In Progress
    In review: In Review
    Needs you: Needs You
    Done: Done
    Abandoned: Canceled
  # Optional. Labels for the abt marker, work type and risk tier (defaults shown).
  labels:
    abt: abt
    workType: { implement: implement, research: research, spike: spike, bootstrap: bootstrap }
    risk: { low: "risk:low", medium: "risk:medium", high: "risk:high" }
---

# abt workflow adapter

Copy to `.agents/abt/workflow.md` in a project. Only the front matter is read.
