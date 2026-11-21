---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
user-invocable: false
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "abt:tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "abt:code-review" to review the work.

Commit your work to the current branch.

## How

1. Trace the subsystem the work touches before writing code.
2. Settle the shape first: the core types and the structure that organises them (a state machine over scattered booleans, a table over branching, a typed model over repeated shape assumptions). When more than one shape is valid (error handling, abstraction layer, test structure), list the alternatives and pick one with a reason; raise an ask-point only if the choice is irreversible.
3. Write the code with a specific scope: file paths, the data shape, success criteria. Make surgical edits. Port a shared-primitive improvement to every consumer and verify each.
4. Verify on the matching surface (the real artifact, not a proxy). "Inconclusive" or the wrong surface is not a pass: flag it.
5. Build, verify and commit each small unit before the next, in an order that proves the work: the failing test first, then the fix.

The runner opens the PR; write its body as the `abt:pr` procedure says.

**Reply:** what you built, what you chose and why, open decisions. A table for design alternatives.
