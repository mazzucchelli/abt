---
description: Onboard this project to abt by agreeing a merge policy with you (usage: /abt:onboard)
---

Run onboarding as a conversation. You probe, propose and walk the owner through each field; the owner decides. Run every `abt` command from the project root.

1. **Probe.** `abt onboard probe`. If the owner can confirm that no installed GitHub App has write access to the repo (a user token can't read that), ask, and on a yes add `--no-write-apps`. Without it the fact stays unknown and the proposal is pr-only. It prints the facts, the proposed preset and why, the policy draft, the global risk catalogue matched to this repo, and the unpaired modules (gaps).
2. **Propose.** Say which preset it proposes and the reasons. solo-self means the runner merges the PR itself (`runner-merge`) under the compensating controls. pr-only is the fallback whenever a fact is missing or ambiguous, and solo-server and team-reviewed are named only: both resolve to pr-only in v1. Never talk the owner into more autonomy than the facts support.
3. **Walk the fields.** One at a time, in the policy's order: required checks, approvals, enforcement and controls, risk cap, mode, evidence, risk map (list the matched catalogue rules and the gaps), size limits. Give a recommendation for each. Save the owner's edits as a YAML file and pass it back with `--draft <file>` (a policy that is not valid is refused with the problems).
4. **Open the PR.** `abt onboard open --team <tracker team key> [--draft <file>] [--no-write-apps]`. It adds `.agents/abt/merge-policy.yaml`, the facts snapshot, `.agents/abt/trees/land.yaml`, the adapter doc and a one-line pointer in `CLAUDE.md`. Give the owner the PR link and say plainly: **they merge it by hand, and until then the project is pr-only.**
5. **After the merge.** The runner pins the protected files on its next scan. `abt onboard settle` does it now. If the PR was closed unmerged, nothing is pinned.

Never merge the onboarding PR yourself, never run `abt onboard pin` (only the owner re-pins a protected file after reading a change to it), and never edit a protected file and its pin in the same change: a file that no longer matches its pin puts the project in Needs you.
