# Build the Lever

**When to apply:** Non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator) instead of working by hand. The tool is the artifact a reviewer can rerun.

When the work isn't trivial, build the tool that does it (a codemod, script, generator, or rerunnable check) instead of doing it by hand. The bar is triviality, not repetition. Skip the tool only for a couple of obvious edits.

- Do the first unit by hand, then build the tool and prove it by rerunning it on that unit. Make it safe to rerun.
- A deterministic tool beats hand-repeated edits. A worker works alone, so the tool is its only multiplier.
- Applying this produces a file. No script, codemod or generator in the diff means you didn't apply it. Commit it when the work outlives the session.
- Build the smallest script that does or proves the job, never a framework.
