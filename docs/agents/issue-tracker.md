# Issue tracker: Linear

Issues and specs for this repo live in Linear, team **ABT** (https://linear.app/mmazzucchelli/team/ABT/overview). Use the Linear MCP tools (`mcp__…__get_issue`, `list_issues`, `save_issue`, `save_comment`, …) for all operations. Load their schemas with ToolSearch if they are deferred. Tools accept human-readable references: issue identifiers such as `ABT-47`, team key `ABT`, and `me`.

## Conventions

- **Create an issue**: `save_issue` with `team: "ABT"`, a title and a markdown description (real newlines, no escapes). Check `list_issues` first for an existing match.
- **Read an issue**: `get_issue` (request `description`, `labels`, `status`, `relations`, `parentId` via `fields`), then `list_comments` for the discussion (`get_issue` does not include comments).
- **List issues**: `list_issues` with `team`, `status`, `labels`, `project` or `query` filters. Results are paginated: follow `cursor` while `hasNextPage` is true.
- **Sub-issue of a parent**: set the parent when creating or updating with `save_issue`.
- **Comment on an issue**: `save_comment` with the issue id.
- **Apply / remove labels**: `save_issue`. Its `labels` parameter replaces the whole label set, so read the current labels first and send the full list.
- **Close**: `save_issue` setting the status to Done (finished) or Abandoned/Canceled (won't do). Statuses belong to the team: check `list_issue_statuses` when unsure.
- **Attach a link**: `create_attachment`, or put the link in a comment.

Linear has no pull-request triage surface for this repo: **PRs as a request surface: no.** PRs only link back to tickets.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team ABT.

## When a skill says "fetch the relevant ticket"

Read it with `get_issue` plus `list_comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. The labels below already exist in team ABT.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Example: ABT-43.
- **Child ticket**: an issue that is a Linear sub-issue of the map. Labels: `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: Linear's native issue relations (blocked by / blocks), set with `save_issue`. Read them with `get_issue` and `includeRelations`. A ticket is unblocked when every blocker is Done.
- **Frontier query**: list the map's open children (`list_issues` filtered by parent), drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `save_issue` assigning `me`, the session's first write.
- **Resolve**: `save_comment` with the answer, set the status to Done, then append a context pointer (gist + link) to the map's Decisions-so-far.
