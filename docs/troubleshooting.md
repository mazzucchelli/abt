# Troubleshooting

Start with three places: `abt runner status`, `$ABT_HOME/runner.err.log` (the runner's own output) and `abt log show <ticket>` (what the runner decided for a ticket, and why).

## Symptoms

**`/abt:` commands don't show up in Claude Code.**
Claude Code was started without the plugin. Start it with `claude --plugin-dir <abt checkout>` ([setup step 3](setup.md#3-load-the-plugin-in-claude-code)).

**`abt: command not found` from a slash command.**
`abt` isn't on the PATH of the shell Claude Code runs commands in. Symlink `bin/abt` into a folder on your PATH ([setup step 1](setup.md#1-get-abt)).

**Enqueue says "runner not running".**
The ticket is enqueued anyway. Start the runner with `abt runner start`; it picks the ticket up on its first scan.

**Enqueue refuses with "no agreed merge policy".**
The project hasn't been onboarded. Run `/abt:onboard`.

**The runner log says `project "…" skipped: …`.**
The reason follows. The usual ones:
- *no adapter doc*: `.agents/abt/workflow.md` isn't on the default branch yet. Merge the onboarding PR.
- *origin is not a GitHub remote*: abt only supports GitHub in v1.
- *`origin/<branch>` is not known*: run `git fetch origin` once in the project.
- *tracker credential not found*: the adapter doc's credential can't be resolved by the daemon. Check that the Keychain item it names exists (`security find-generic-password -s abt-linear`). An `env:` credential never works here (see [known limits](#known-limits-of-v1)).

**`runner status` shows "dispatch refused: …".**
The startup self-test failed, so no worker will start. Run `abt selftest` in a terminal and fix what it reports: usually the Keychain token (`Claude Code token not found: add it to the Keychain as "abt-claude-oauth"`), a Claude Code older than the profile's `min-version`, or a `binary` the runner's PATH can't find.

**`runner start` refuses with "… is not on the runner's PATH".**
`abt runner start` gives the daemon the PATH of the shell you run it in, and refuses when `gh` or the launch profile's `binary` isn't on it. Install the missing tool, or run `abt runner start` again from a shell whose PATH finds it. `runner status` prints a `missing:` line when a tool has gone missing since (an uninstall, or a Homebrew move).

**A ticket stays in Todo.**
Check that it carries both the abt marker label and a work-type label, that the project is in `$ABT_HOME/config.yaml`, and that all its blockers are Done. `abt runner nudge <ticket>` asks the runner for a pass now.

**A spike or bootstrap ticket is refused.**
Expected in v1: those work types have no tree yet. The ticket is refused with that reason and never runs as implement.

**Every ticket of a project is in Needs you with "protected abt files changed without their pin".**
A file under `.agents/abt/` changed on the default branch. Read the change. If you agree with it, run `abt onboard pin` in a terminal at the project root. If not, revert it. Then reply to the tickets (`re-run`).

**Merges stopped with a `probe` record and a drift ticket in Needs you.**
A repo setting the policy was agreed against changed (protection, collaborators, visibility...). Undo the change, or re-agree with `/abt:onboard`, then reply to the drift ticket.

**The PR is green and approved, but abt doesn't merge.**
`abt log show <ticket>` says why on the `land` line: no policy, `mode: pr-only`, files not pinned yet, a land tree that doesn't match the policy's `land_tree_hash`, or a head that moved since CI ran.

**An abt file in a PR has a failing `abt/validate` status.**
The status description has the first `file:line:col` error. Run `abt validate <file>` locally for the full list.

**A worker keeps failing.**
Read its transcript in `~/.agents/abt/runs/<ticket>/` and the kept worktree under `$ABT_HOME/worktrees/<project>/` (kept 7 days). After two failures at a level the runner steps up the model or effort. After the last attempt at `hard`, the ticket goes to Needs you.

## Known limits of v1

- **One stack.** Linear, GitHub through `gh`, Claude Code, and macOS (launchd and Keychain). Nothing else is wired yet.
- **The daemon's environment is minimal.** launchd starts the runner with only `ABT_HOME` and the `PATH` of the shell that ran `abt runner start`. Nothing else from your shell profile reaches it, so an `env:` tracker credential is not visible to the daemon: use `keychain:` (what `onboard open` writes by default). After changing your PATH, run `abt runner stop && abt runner start` to hand the new one over.
- **Spike and bootstrap** have no trees yet and are refused.
- **Research acknowledgement.** The research tree waits for an acknowledgement that can't be given from Linear yet, and `review=auto` can't be turned on, so finished research escalates to Needs you after 2 days. Answer it there.
- **Presets.** Only `pr-only` and `solo-self` resolve. `solo-server` (protected branch) and `team-reviewed` (several writers) are recognised but treated as pr-only.
- **No published releases.** Pin an install from a tag you make in your own clone ([setup step 8](setup.md#8-pin-an-install-recommended-once-you-use-it-for-real)).
