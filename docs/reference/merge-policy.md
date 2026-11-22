# Merge policy

`.agents/abt/merge-policy.yaml` in a project says when abt may merge its own PRs. `/abt:onboard` writes it with you, and you merge it by hand. The schema is [`schema/merge-policy.schema.json`](../../schema/merge-policy.schema.json). A commented example is in [`docs/examples/merge-policy.yaml`](../examples/merge-policy.yaml).

```bash
abt validate .agents/abt/merge-policy.yaml   # schema, plus the fixed rules it may not loosen
```

**Fail closed.** With no policy, an invalid one, `mode: pr-only`, or files that aren't pinned yet, abt opens the PR and never merges it.

## Fields

### `version`
Always `1`.

### `gates`
```yaml
gates:
  required_checks: [can-merge]   # CI jobs, by name, that must succeed on the PR's head SHA (at least one)
  approvals: 1                   # human approvals a PR above the risk cap needs (at least 1)
```
Name one **aggregator** job (a job that `needs:` all the others) rather than listing every job. Then adding a job to CI doesn't require a policy change.

### `enforcement`
- `server`: GitHub enforces the gates (branch protection).
- `self`: the runner enforces them. `compensating_controls` must then list both controls.

### `compensating_controls`
Required with `enforcement: self`, and must contain both:
- `runner-sole-merger`: only the runner merges, and only through `runner-merge`;
- `head-sha-recheck`: the head SHA is re-read right before the merge, and the merge is pinned to it.

### `risk_cap`
The highest risk tier that merges with **no** human approval: `low`, or `none` (every merge needs `gates.approvals`).

### `mode`
`merge`, or `pr-only` (abt opens PRs and never merges).

### `evidence`
```yaml
evidence:
  self_certification: false   # the only allowed value
```
The agent's own new tests or snapshot baselines never count as evidence for its own PR. They count once a human has merged them.

### `risk_map`
What raises the risk floor in this project, on top of the global catalogue.

```yaml
risk_map:
  rules:
    - { glob: "convex/schema.ts", tier: high, reason: "database schema" }
    - { glob: "src/emails/**",    tier: medium, reason: "user-facing emails" }
  pairing:
    - { glob: "src/billing/**", checks: [test/billing/invoice.test.ts] }
  max_lines: 400    # added + removed lines above which a change is at least medium (default 400)
  max_files: 15     # changed files above which a change is at least medium (default 15)
```

- `rules` add floors: any change touching a matching path is at least that tier.
- `pairing` declares which committed checks cover a module, beyond the naming convention (a sibling test that a required CI job runs). A touched file with no covering check is an **evidence gap**, which makes the change at least medium. Only an e2e spec on the touched route covers UI.
- A project can only **tighten** the fixed rules. Dependency manifests and lockfiles, CI/config/infra files and migrations are never low, and a baseline update or visual diff is at least medium. A rule that tries to lower one fails validation.

The global catalogue that always applies (high: migrations and schemas, auth, payments, secrets, CI/deploy/infra, public API contracts, the protected abt files and ADRs; medium: lockfiles, tool config, generated files, agent instruction files, snapshot baselines, scripts) is listed in [`src/risk/rules.ts`](../../src/risk/rules.ts). `abt onboard probe` shows which catalogue entries match your repo.

### `facts`
A snapshot of the repo's cheap facts when the policy was agreed. Onboarding fills it. Before every merge and at start, the runner re-probes each recorded fact, and any difference pauses merging (**drift**). A fact left out isn't compared.

```yaml
facts:
  default_branch: main            # required
  captured_at: "2026-11-20T00:00:00Z"
  visibility: private
  protection: { enforced: false, required_checks: [], approvals: 0 }
  allow_auto_merge: false
  write_collaborators: [your-github-login]
  write_apps: []
  snapshot_hash: …                # sha256 of .agents/abt/facts.yaml, written by onboarding
```

### `land_tree_hash`
The sha256 of the land tree this policy was agreed with (the project's `.agents/abt/trees/land.yaml`, else the shipped one). A different land tree blocks merging.

```bash
shasum -a 256 .agents/abt/trees/land.yaml
```

## Presets

Onboarding proposes one of these from the probed facts. You edit it before agreeing.

| Preset | When it's proposed | v1 behaviour |
| --- | --- | --- |
| `pr-only` | any fact missing or ambiguous, a public repo, write apps, no CI aggregator, no test tooling | abt never merges |
| `solo-self` | private repo, one writer, no server-side protection, a CI aggregator, test tooling | the runner merges under `enforcement: self` |
| `solo-server` | branch protection is enforced on the default branch | treated as pr-only |
| `team-reviewed` | more than one person can write | treated as pr-only |
