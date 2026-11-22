# Done for adapter and wiring tickets

A ticket that builds or wires a real-world adapter (tracker, code host, harness, or the runner code that uses one) is **Done** only when the adapter has run against the real backend at least once. Passing against a fake is not enough: the fake can drift from reality, and a ticket Done on fakes alone leaves the README and the board disagreeing about what exists.

## The rule

An **adapter ticket** (one that adds or changes a real adapter) is Done when all of these hold:

- The adapter's contract suite runs on the in-memory fake and on the real adapter (the real one may sit over an in-memory stand-in for its CLI or API).
- The same suite runs **opt-in** against a real sandbox backend, gated by an `ABT_TEST_*` variable and left out of `npm test` and CI. The README says how to run it.
- The ticket carries the output of one real run (command and result) as a comment.

Existing sandboxes: `ABT_TEST_LINEAR` (a Linear sandbox team) and `ABT_TEST_GITHUB` (a GitHub sandbox repo). A new adapter adds its own `ABT_TEST_*` suite beside them.

A **wiring ticket** (one that connects real adapters into the runner, such as serving configured projects with real deps) is Done when it is covered by tests with the real adapters' types in place. It does not prove the whole path on a real project, so its description says so and links the pilot ticket (the first onboarded real project), which is the single end-to-end proof for v1. A dedicated e2e project for every wiring ticket is out of scope for v1.

## Splitting

When `ticket-splitting` meets work that needs both a contract and a real adapter, it makes two tickets:

1. **Contract + fake**: Done against the fake. Its title says "contract" or "fake", never the capability itself.
2. **Real adapter + wiring**: blocked by the first, and carries the criteria above.

The capability counts as delivered only when the second ticket is Done.

## Main stays green

Two PRs that are each green can make `main` red once both merge. The `protect-main` ruleset prevents this: it requires a PR and an up-to-date branch with the `can-merge` check (which aggregates test, build and typecheck). A project that adopts abt needs the same, or a merge queue.
