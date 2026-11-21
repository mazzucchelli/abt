---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
user-invocable: false
---

Spin up a **background agent** to do the research, so you keep working while it reads. A worker's tool set is fixed: if it has no sub-agent tool, do the research yourself, to the same brief.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

## Investigations

A question about how the code works or why it is shaped that way is read-only: trace the code (and, for "why", the history behind the design) and answer with a cited explanation, not a change. Shape the file as Overview, Key Concepts, How It Works, Where Things Live, Gotchas. For a choice between alternatives, give a recommendation with a tradeoffs table. Open no PR; if the answer calls for a code change, say so and name `abt:diagnosing-bugs` or `abt:implement`.

For an "are we sure?" question, give your real judgment with reasons, and push back if the premise is wrong.
