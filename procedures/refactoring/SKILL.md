---
name: refactoring
description: Restructures code without changing its behavior, pinning current behavior with a characterization test before any structure moves. Use for focused-to-medium cleanups, reshapes, and renames where the contract must stay the same.
user-invocable: false
---

**The structure changes. The behavior does not.** Distinct from implement, which adds behavior, and diagnosing-bugs, which corrects it.

If the cleanup reveals a missing feature or a real bug, split it out and ship the structural change first against the pinned contract. A redesign is allowed, but name it and route to implement. This procedure is the focused-to-medium change.

1. Pin the behavior contract first. Trace the affected subsystem to learn the contract, then write a characterization test, snapshot, or equivalence harness that captures current behavior before any structure moves. If the area has no coverage, write the pin before touching structure. Type check and lint are not a pin.
2. Name the structure the code is missing. Boring code stays when the shape is already clear and local. The reshape must delete branches or invalid states, not add indirection.
3. Name the target shape. State what the module layout, types, and call graph should be if built today. If the target crosses a function boundary, settle the shape before the move.
4. Subtract before you add. Delete dead code, collapse one-caller wrappers, drop redundant validators, and remove orphan references before introducing the new shape. The smallest change that reaches the target shape ships. A speculative cleanup that "might help" gets reverted.
5. Move in small behavior-preserving steps, each keeping the pin green. For API reshapes, migrate every caller and delete the old API in the same wave. No compatibility shims, no parallel old-and-new paths. Spot-check every rename against the actual files. Renames silently miss usages in strings, prose, and back-references. Make the mechanical edits with a specific scope (file paths, the names being moved, the behavior to hold).
6. Prove behavior is unchanged on the real artifact, not "it compiles". For larger reshapes, run an equivalence check: a script that diffs old-vs-new outputs, a recorded baseline replayed against the new code, or a smoke run on the matching surface.
7. Confirm the change is worth keeping. The success measure is reduced reader load. If the diff does not lower reader load somewhere, revert it.
8. Rebase into small ordered commits. A subtraction commit, then the reshape, then any follow-on cleanup. Build each behavior-preserving slice so it stays green before the next. The runner opens the PR; write its body as the `abt:pr` procedure says.

**Reply:** the structure that changed, the pin you held it against, the equivalence proof, the reader-load delta, what shipped and what got reverted. No new behavior.
