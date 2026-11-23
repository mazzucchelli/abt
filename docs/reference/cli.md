# CLI

`abt <command>`. Run `abt` with no arguments, or `abt <command>` with missing arguments, for usage. Exit codes: `0` success, `1` the command ran and failed, `2` usage error. Project-scoped commands act on the current directory unless given `--project <dir>`.

## Slash commands (Claude Code)

| Command | Runs |
| --- | --- |
| `/abt:enqueue <ticket>... \| <free text> [work type]` | `abt enqueue` or `abt create`, relays the ack; `abt block` and `abt reply` on your yes |
| `/abt:onboard` | the onboarding conversation: `abt onboard probe`, then `open` |
| `/abt:to-spec` | the `spec-writing` procedure with you |
| `/abt:to-tickets <plan>` | the `ticket-splitting` procedure with you |
| `/abt:triage <ticket>...` | the `triaging` procedure with you |
| `/abt:grill-with-docs <plan>` | the `grilling` and `domain-modeling` procedures with you |

## Hand work over

```
abt enqueue <ticket[:type]>... [--type T | --entry T | --inferred T [--exploratory]]
abt create  [--type T | --entry T | --inferred T [--exploratory]] [--] <text...>
abt block   <ticket> <blocker>
abt reply   <ticket> <text...>
```

- `enqueue`: one tracker write per ticket (marker and work type), then a nudge. With several tickets it prints a table. `<ticket>:<type>` gives one ticket its own type.
- Type precedence: `--type`, then the ticket's own label, then `--entry`, then `--inferred` (written back as "inferred"). `--exploratory` makes an inferred `implement` a question instead. `bootstrap` is never accepted as `--inferred`.
- `create`: creates the ticket from the text, then enqueues it. Put `--` before text that contains flags.
- `block`: adds a "blocked by" relation.
- `reply`: posts your text to the ticket as your comment, for answering an escalation from a chat.

## Onboarding

```
abt onboard probe  [--no-write-apps]
abt onboard open   --team <key> [--credentials-keychain <item> | --credentials-env <VAR>] [--draft <merge-policy.yaml>] [--no-write-apps]
abt onboard settle
abt onboard pin
```

- `probe`: prints the facts, proposed preset and reasons, policy draft, matched risk catalogue and gaps, as JSON.
- `open`: opens the onboarding PR. `--draft` is your edited policy. `--credentials-keychain` names the Keychain item holding the Linear key (default `abt-linear`); `--credentials-env` names an env var instead, which the runner daemon can't see.
- `settle`: records pins once you've merged the onboarding PR (the runner also does this on its scan).
- `pin`: re-pins the protected files as the default branch has them now. Needs you at a terminal, typing the project id. Refused to workers.

## Runner

```
abt runner start | stop | status | nudge <ticket> | run [--world <world.json>]
abt watch [--once]
abt selftest
```

- `start` / `stop`: install and load, or unload, the launchd agent `dev.abt.runner`. `start` hands the agent this shell's `PATH`, and refuses when `gh` or the launch profile's `binary` isn't on it.
- `status`: exit 0 when running, 3 otherwise; also shows whether dispatch is refused and why, and a `missing:` line for `gh` or `binary` when the agent's PATH no longer finds it.
- `nudge`: ask the running runner for a pass on a ticket now.
- `run`: the daemon in the foreground (what launchd runs). `--world` runs it against a fake world.
- `watch`: read-only live board (`b` board, `j`/`k` scroll the log, space pause, `q` quit). `--once` prints one frame.
- `selftest`: the startup self-test of this install against Claude Code.

## Trees and logs

```
abt validate <file>
abt run <tree.yaml> <ticket> --world <world.json>
abt log show <ticket> [--run <id>]
abt log append <ticket>        # record JSON on stdin
```

- `validate`: a tree, or a merge policy if the file is named `merge-policy.yaml`. Diagnostics are `file:line:col message`.
- `run`: one pass of a tree against a [fake world](../first-pass.md). Prints the pass's log and result.
- `log show`: the ticket's [decision log](decision-log.md): the latest run, or the one `--run` names. Superseded records are flagged in the NOTE column.
- `log append`: writes one record. Workers use it for `ask-point`, `pivot` and `blocked` records only.

## Installs

```
abt upgrade <tag> [--from <repo>]
abt upgrade --list
```

Installs a tag under `$ABT_HOME/installs/`, self-tests it, and switches `current` only if the test passes. An installed tag is a rollback.
