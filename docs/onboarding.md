# Onboard a project

Onboarding is how abt meets a project. You agree a **merge policy** (when, if ever, abt may merge on its own), abt opens a PR with the project's abt files, and **you merge that PR by hand**. Then you register the project with the runner.

Until the onboarding PR is merged, the project is **pr-only**: abt opens PRs and never merges them.

## Before you start

- The [machine setup](setup.md) is done: `abt` is on your PATH, the plugin is loaded, `gh` is signed in.
- The project is a git checkout whose `origin` is on GitHub, and its default branch is fetched.
- The Linear team for the project has the six workflow states abt needs (it maps them by name; see [adapter doc](reference/adapter-doc.md#states)) and the labels `abt`, `implement`, `research`, `spike`, `bootstrap`, `risk:low`, `risk:medium`, `risk:high` (or your own names, mapped in the adapter doc).

### What makes a project ready for autonomous merge

abt proposes the **solo-self** preset, the only one that lets the runner merge, only when all of these hold:

- the repo is **private**, and you are its **only** writer (no other collaborators, and no GitHub App or deploy key with write access);
- the default branch has **no server-side protection** (in solo-self the runner itself enforces the gates);
- CI has an **aggregator job**, one job that waits on all the others, like `can-merge` in [this repo's CI](../.github/workflows/ci.yml), so a single required check covers everything;
- the repo has **test tooling** abt can find.

If any fact is missing or points elsewhere, the proposal is **pr-only**, and that is a fine place to start. `solo-server` and `team-reviewed` are recognised and named in the proposal, but in v1 both resolve to pr-only.

## 1. Run `/abt:onboard`

Open Claude Code (with the plugin) at the project root and type `/abt:onboard`. The primary agent runs the conversation. Under the hood:

1. **Probe.** `abt onboard probe` reads the project's facts: visibility, protection and rulesets, write collaborators, deploy keys, CI jobs and their aggregator, test tooling. It prints them with the proposed preset and why, a policy draft, the global risk catalogue matched to the repo's files, and the **gaps** (modules with no paired test).
   A user token can't see installed GitHub Apps. If you know no App can write to the repo, say so, and the agent adds `--no-write-apps`. Otherwise that fact stays unknown and the proposal stays pr-only.
2. **Walk the fields.** The agent goes through the policy one field at a time (required checks, approvals, enforcement, risk cap, mode, evidence, risk map, size limits), recommends a value for each and records your edits in a draft file. The [merge policy reference](reference/merge-policy.md) explains every field.
3. **Open the PR.** `abt onboard open --team <LINEAR TEAM KEY> --draft <draft>` opens one PR that adds:

   | File | What it is |
   | --- | --- |
   | `.agents/abt/merge-policy.yaml` | the agreed policy |
   | `.agents/abt/facts.yaml` | the facts snapshot the policy was agreed against |
   | `.agents/abt/trees/land.yaml` | the land tree the policy is bound to (by hash) |
   | `.agents/abt/workflow.md` | the [adapter doc](reference/adapter-doc.md): Linear team, credentials, state names |
   | `CLAUDE.md` | one line pointing agents at `.agents/abt/` |

## 2. Review the PR, then merge it yourself

Read the PR like any other. Two things to check or change on its branch before merging:

- **Credentials.** `onboard open` writes `credentials: { env: LINEAR_API_KEY }` (or the name you passed with `--credentials-env`). The runner can't see your shell's environment, so change it to the Keychain item you created in [setup](setup.md#2-store-the-credentials):

  ```yaml
  credentials:
    keychain: abt-linear
  ```

- **States.** The generated `states` assume Linear's default names plus a `Needs You` state. Make them match your team exactly.

Then **merge it by hand**. abt never merges this PR, and it never merges any later change to these files either.

## 3. Register the project with the runner

Add the project to `$ABT_HOME/config.yaml` (`~/.local/state/abt/config.yaml` by default; create it if it doesn't exist):

```yaml
projects:
  - name: meal-planner              # any unique name; it shows in logs and `abt watch`
    path: /Users/you/src/meal-planner
    # maxWorkers: 1                 # optional: a lower cap for this project
# maxWorkers: 3                     # optional: the global cap on running workers
```

Restart the runner so it reads the new list:

```bash
abt runner stop && abt runner start
```

`$ABT_HOME/runner.err.log` should now say `abt runner: serving project "meal-planner" (…)`. If it says `skipped`, the reason follows: usually a missing adapter doc (the PR isn't merged yet), a non-GitHub `origin`, or an unfetched default branch.

## 4. Pins

On its next scan the runner sees the merged onboarding PR and records **pins**, the sha256 of every protected file, in `$ABT_HOME/pins/<owner>__<repo>.json`. To do it right away, from the project root:

```bash
abt onboard settle
```

It prints whether the PR is merged and the files are pinned, still open, or closed unmerged (then nothing is pinned and the project stays pr-only).

The protected files are `.agents/abt/merge-policy.*`, `workflow.md`, `facts.yaml`, `trees/**` and `checks/**`. From now on:

- if any of them changes, appears or disappears on the default branch without a matching pin, **every ticket in the project stops in Needs you**, and nothing merges;
- you read the change, and if you agree, re-pin it at a terminal: `abt onboard pin` shows what changed and asks you to type the project id (`<owner>__<repo>`). Workers are refused this command.

Any change to a protected file is also always **high risk**, so an agent can't slip one through as low.

## 5. Your first ticket

Write a small, low-risk ticket in the project's Linear team, something touching code that already has tests. Then, in Claude Code at the project root:

```
/abt:enqueue MP-12
```

Follow it with `abt watch` and `abt log show MP-12`. [Day-to-day use](daily-use.md) covers the rest.

## Guards that stay on after onboarding

- **Validation of abt files in PRs.** For any open PR that touches `.agents/abt/` files, the runner posts an `abt/validate` commit status on its head, once per head: failing with the first `file:line:col` error, or passing. The merge policy is checked against its schema and the fixed rules it may not loosen. No CI workflow is added to your repo for this.
- **Drift.** Before every merge, and when it starts, the runner re-probes the cheap facts recorded in the policy's `facts` (default branch, visibility, branch protection, auto-merge, write collaborators and apps) and checks the pins. Any difference logs a `probe` record, pauses merging for the project and opens Needs you with the diff. Merging resumes once you've dealt with that ticket (reply or abandon). If the project still differs, it pauses again, so either undo the change or re-agree the policy with `/abt:onboard`.
- **Post-merge watch.** After each autonomous merge, a red required job on the merge commit pauses merging and opens a revert PR for you to merge.

State for the last two lives in `$ABT_HOME/guard/<project id>.json`.

## Changing the policy later

Run `/abt:onboard` again. It opens a new PR with the updated files. Merge it by hand, then re-pin with `abt onboard pin`, or let the runner settle it. Don't edit a protected file and its pin in the same change.

---

Next: [day-to-day use](daily-use.md).
