# Prove It Works

**When to apply:** After completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.'

Verify every output by checking the real thing directly: run the feature, read the actual value, inspect the diff. Proxies (file mtimes, self-reports, cached output, "it compiles") do not count. When a check fails, suspect the observation method before the system.

Script the check when you can. A deterministic script that reruns the comparison beats a one-time look. Put its output in the PR description or the decision log, and commit the script only when the trail must be auditable later.
