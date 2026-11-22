# Install and set up

You do this once per machine. At the end, `abt` is on your PATH, the `/abt:` commands work in Claude Code, and the runner daemon is running.

## Prerequisites

| You need | Why | Check |
| --- | --- | --- |
| **macOS** | the runner is a launchd agent and reads secrets from the Keychain | — |
| **Node 24 or newer** | abt runs its TypeScript sources directly | `node --version` |
| **git** | worktrees, branches | `git --version` |
| **GitHub CLI**, signed in | every GitHub read and write goes through `gh` | `gh auth status` |
| **Claude Code** 2.1.293 or newer, on a Claude subscription | the primary agent and every worker | `claude --version` |
| **A Linear workspace** and a personal API key | the tracker, the only one supported in v1 | — |

Your projects must be on GitHub, with `origin` pointing at GitHub.

## 1. Get abt

```bash
git clone https://github.com/mazzucchelli/abt.git ~/src/abt
cd ~/src/abt
npm install
```

Put `abt` on your PATH. The slash commands call it by name:

```bash
mkdir -p ~/.local/bin && ln -s ~/src/abt/bin/abt ~/.local/bin/abt
```

Check: `abt validate defaults/trees/land.yaml` exits 0 with no output.

## 2. Store the credentials

abt never stores secrets in files. Config files refer to secrets *by name*: a Keychain item or an environment variable.

**Claude Code token for workers.** Workers run headless on your subscription with a long-lived OAuth token. Create one and store it in the Keychain under the item name `abt-claude-oauth` (the default):

```bash
claude setup-token
```

```bash
security add-generic-password -s abt-claude-oauth -a "$USER" -w
```

The second command prompts for the token, so it never lands in your shell history.

**Linear API key.** Create a personal API key in Linear (Settings → Security & access → Personal API keys). Store it in the Keychain too:

```bash
security add-generic-password -s abt-linear -a "$USER" -w
```

Your project's [adapter doc](reference/adapter-doc.md) will refer to it as `credentials: { keychain: abt-linear }`.

> **Why the Keychain and not `LINEAR_API_KEY`?** launchd starts the runner with only `ABT_HOME` in its environment, so variables from your shell profile never reach it. An `env:` credential works for commands you run in a terminal, but not for the daemon. See [known limits](troubleshooting.md#known-limits-of-v1).

## 3. Load the plugin in Claude Code

The abt plugin gives your Claude Code chat the `/abt:` commands (`enqueue`, `onboard`, `to-spec`, `to-tickets`, `triage`, `grill-with-docs`) and the procedures workers follow. Start Claude Code with it:

```bash
claude --plugin-dir ~/src/abt
```

To always have it, add an alias to your shell profile, for example `alias claude='claude --plugin-dir ~/src/abt'`. Type `/abt:` in a chat to check that the commands are listed.

Workers don't need this step: the runner loads the plugin for them from the pinned install.

## 4. Choose the abt home (optional)

The **abt home** holds everything the runner owns: the decision logs, pins, worktrees, the runner's own logs and the pinned installs. It defaults to `~/.local/state/abt` (or `$XDG_STATE_HOME/abt`). To put it elsewhere, export `ABT_HOME` in your shell profile **before** you start the runner. `abt runner start` passes it on to launchd.

## 5. Configure the launch profile (optional)

`~/.agents/abt/config.yaml` tells the runner how to start Claude Code. Every key has a default, so you can skip this file. You'll likely want to set `binary` to an absolute path, because launchd's PATH does not include Homebrew or npm global folders:

```yaml
launch-profiles:
  claude-subscription:
    binary: /opt/homebrew/bin/claude   # `which claude`
    keychain: abt-claude-oauth         # the Keychain item from step 2
```

All keys are in [configuration](reference/configuration.md#launch-profile-agentsabtconfigyaml).

## 6. Check that workers can start

```bash
abt selftest
```

This runs the startup self-test the runner runs before it dispatches anything: it starts Claude Code with the pinned models and the Keychain token and checks the result. Fix anything it reports before going on.

## 7. Start the runner

The runner serves the projects listed in `$ABT_HOME/config.yaml`. That list is empty until you [onboard a project](onboarding.md), so you can start the runner now or after onboarding.

```bash
abt runner start     # writes ~/Library/LaunchAgents/dev.abt.runner.plist and loads it
abt runner status    # "runner running (pid …, heartbeat 3s ago)"; exit 0 when running, 3 otherwise
```

The runner's own output goes to `$ABT_HOME/runner.out.log` and `$ABT_HOME/runner.err.log`. At start it prints one line per project: `serving project "…"`, or `project "…" skipped: <reason>`.

launchd keeps the runner alive and starts it at login. `abt runner stop` unloads it.

## 8. Pin an install (recommended once you use it for real)

If the runner ran straight from `~/src/abt`, every `git pull` or local edit would change live runs. A **pinned install** is a fixed copy of a tagged release under `$ABT_HOME/installs/<tag>/`, with a `current` pointer that the runner, its workers and `bin/abt` all follow:

No release is tagged upstream yet, so tag the commit you want in your clone and install from it:

```bash
git -C ~/src/abt tag local-2026-11-22
abt upgrade local-2026-11-22 --from ~/src/abt
abt runner stop && abt runner start   # the launchd agent now runs the pinned copy
```

`upgrade` installs the tag, runs its self-test, and switches `current` only if the test passes. With no pinned install, everything runs from your checkout. [Day-to-day use](daily-use.md#upgrade-and-roll-back) covers upgrades and rollbacks.

---

Next: [onboard a project](onboarding.md).
