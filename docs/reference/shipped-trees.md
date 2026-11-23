# Shipped trees

abt ships one tree per step of a ticket's life, in [`defaults/trees/`](../../defaults/trees/). For an `implement` ticket the runner runs `claim`, then `implement`, then `cleanup` on any terminal state. Once the ticket is In review, it runs `land` on every poll. A `research` ticket runs `research`.

A project can replace any of them by committing a tree with the same name to `.agents/abt/trees/` ([customize a tree](../how-to/customize-a-tree.md)).

## claim

```yaml
id: claim
action: claim
```

Assigns the ticket, creates its branch and worker worktree, moves it to In progress. The runner checks afterwards that the ticket really is claimed and has a worktree, and refuses to go on otherwise.

## implement

```yaml
id: implement
seq:
  - retry: 3                       # implement/0: up to three tries at a spec the gate accepts
    do:
      ensure:
        cond:
          check: spec-ready        # a mapped spec is on the tracker, or the skip applies
        else:
          agent: spec-writing
  - action: await-spec-approval    # implement/1: high risk waits in Needs you for your approval
  - retry: 5                       # implement/2: the work, with model/effort step-ups
    do:
      agent: tdd
  - ensure:                        # implement/3: a PR exists
      cond:
        check: pr-exists
      else:
        action: open-pr
  - action: land                   # implement/4: ends `open`, handing over to the land tree
```

How retries meet routing: the runner steps the model and effort up after every two failures, and stops at the first failure at the hardest level. So `retry: 5` allows two attempts below hard, two more one level up, and one at hard, depending on where the grade starts.

## land

```yaml
id: land
fallback:
  - check: pr-merged               # already merged (by abt or by you): done
  - seq:
      - check: ci-check-green      # required jobs green on the head SHA
      - check: head-sha-unchanged  # and the head hasn't moved since
      - fallback:
          - check: risk-within-cap # low enough to merge with no human...
          - check: pr-approved     # ...or approved
          - timeout: 2d
            do:
              action: await-approval
          - action: escalate       # nobody approved in 2 days: Needs you
      - action: runner-merge
```

Onboarding commits a copy of this tree to the project as `.agents/abt/trees/land.yaml`, and the merge policy records its sha256 as `land_tree_hash`. The project's copy wins over this default, so an abt upgrade never changes how an onboarded project lands. If the land tree in use doesn't match the hash, merging is blocked and the ticket goes to Needs you. If you change it, re-agree the policy so the hash matches.

## research

```yaml
id: research
seq:
  - action: claim-no-worktree
  - retry: 3
    do:
      ensure:
        cond:
          all:
            - check: findings-linked
            - check: gist-filled
            - judge: Do the findings cite primary sources, not just secondary commentary?
        else:
          agent: research
  - fallback:
      - check: review-auto
      - timeout: 2d
        do:
          action: await-ack
      - action: escalate
  - action: cleanup
```

Research ends in a doc, never in code: no branch, no worktree, no PR. The judge sits inside the `ensure`, so findings it rejects send the worker back with the judge's reason. `review-auto` holds when the [adapter doc](adapter-doc.md#research) sets `research.review: auto`; otherwise `await-ack` waits for the owner to reply `ack`.

## cleanup

```yaml
id: cleanup
action: cleanup
```

Removes the worktree. The runner runs it on every terminal state. After a failure it keeps the worktree 7 days instead.
