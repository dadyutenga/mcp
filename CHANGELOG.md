# Changelog

## 1.5.4 — 2026-10-31

- Fetch shared requests and other resources through a registered worker that is
  actually authorized to read them. A target delegate can read a request created
  by another editor even when both have registered its source repository.
- Preserve the enforced read, acknowledgement, work, progress and evidence
  workflow from 1.5.3. Add coverage for the live Cursor/Antigravity routing case.

## 1.5.3 — 2026-10-31

Enforce an explicit collaboration request handling workflow.

- Add `request_read` delivery receipts and revision-bound `request_work`
  acknowledgements with one exclusive handler, progress and concrete blockers.
- Gate ordinary MCP writes while incoming requests require acknowledgement or
  renewed progress. Gate task completion while the agent has unfinished request work.
- Require a live working claim, approved scope and evidence when answering.
- Expire working claims after five minutes without explicit progress; recheck
  blockers after 15 minutes. Clarification invalidates old reads and claims.
- Expose handling status and source-side progress events without confusing
  connection heartbeat, background delivery, acknowledgement and completion.
- Send inbox log notifications and subscribed resource updates on five-second
  checks, with minute reminders for unattended requests. Preserve next-call gates
  for clients that ignore notifications; do not claim to wake unsupported editors.
- Add a filtered attention inbox so handled pages cannot hide unread requests.
- Isolate verified MCP credentials' rate budgets so background checks from one
  client cannot exhaust another client's allowance. Reauthenticate every call.

Update the service and reload each client's Coordination MCP bridge. Existing
requests use the new workflow automatically; credentials and database history
are retained. Answers now require an `evidence` field.

## 1.5.2 — 2026-10-31

All registered repositories now stay active together, and incoming collaboration
requests reach their target repository's delegates.

- Remove the single-active-repository requirement. Aggregate reads, identities,
  snapshots, inboxes and events across registered roots with bounded pages.
- Route existing task, reservation and request operations by resource ID. Approvals
  and answers use the target repository; new writes require an explicit repo ID.
- Deliver request creation, clarification and decision events to authorized target
  delegates, including existing requests. Preserve source/target permission checks.
- Add `collaboration_inbox` and pending-request notices on ordinary bridge replies.
- Explain that online presence is a connection heartbeat, not a read receipt or a
  promise that an external agent will answer without using its MCP connection.
- Retain native PostgreSQL setup, global client configs, credentials and history.

Update with `git pull --ff-only`, restart the local service and reload Coordination
in each client's MCP settings. No database reset or new migration is required.

## 1.5.1 — 2026-10-31

The installer now connects directly to PostgreSQL and starts the Node service.

- Remove Docker prompts, commands and prerequisites from guided setup.
- Ask for PostgreSQL host, port, database, username and a hidden password. Defaults
  are `127.0.0.1`, `5432`, `coordination` and `postgres`; no password is assumed.
- Verify PostgreSQL credentials and version before saving configuration. Offer to
  create a missing database with the supplied user's permission.
- Encode special characters in connection credentials correctly.
- Start a background Node service with private logs and PID information, and
  verify actual readiness before reporting **READY**.
- Reuse saved settings and distinguish PostgreSQL login from an existing
  Coordination operator account. Preserve existing databases and configuration.
- Add regression tests for the original Docker-only failure and integration tests
  for native startup, saved settings, wrong passwords and database creation.

Update an existing checkout with `git pull --ff-only`, then run
`node setup.mjs --client all`. PostgreSQL 16+ must be installed and running.

## 1.5.0 — 2026-10-31

This release adds native global setup for Codex, Claude Code and Grok Build to the
existing Cursor and Antigravity integrations. One MCP service coordinates agents
across repositories without requiring configuration in each repository.

- Configure Codex and Grok Build with their native `mcp_servers` TOML tables.
- Configure Claude Code in user-scope `~/.claude.json`, preserving project state.
- Select multiple clients with `node setup.mjs --client codex,claude,grok`, or
  install all five with `--client all`. `claude-code` and `grok-build` aliases work;
  the earlier `both` selection remains compatible.
- Preserve unrelated settings and integrations. Save private original-file backups
  before changing existing configuration; reject conflicting unmanaged servers.
- Add generic JSON setup for other clients that accept the `mcpServers` layout,
  with an explicit user configuration path.
- Retain automatic Git workspace registration, stable repository-scoped identities,
  peer discovery, scoped collaboration requests and revocable enrollment tokens.
- Report version 1.5.0 through the setup CLI, service metadata and MCP handshake.

### Install or update

Requirements: Node.js 24+, Git, and a running Docker installation for a new local
service. Connecting to an existing service does not require Docker on the client.

```sh
git clone --branch v1.5.0 https://github.com/dadyutenga/mcp.git
cd mcp
node setup.mjs --client codex,claude,grok
```

For an existing checkout, run `git pull --ff-only`, then rerun setup for the clients
you want to add. Dependency installation is automatic. Existing service data and
private credentials are retained; no database reset or new migration is required.
Reload/enable `coordination` in each selected client's MCP settings after setup.
Clients without workspace roots can use `workspace_register` with the repository path.

The release includes a source ZIP and SHA-256 checksums. Extract the ZIP and run
`node setup.mjs` from the extracted directory. Native client configuration is
validated with integration tests; the full Docker runtime test requires Docker.
