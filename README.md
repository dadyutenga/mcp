# MCP Agent Coordination

A **headless coordination service** for agents working across two or more repositories.
Agents connect through MCP to share work status, coordinate tasks and file leases,
publish versioned context, request scoped help, and discover authorized peers.
There is no frontend or browser setup.

The central product uses PostgreSQL, authenticated Streamable HTTP MCP and a stdio
bridge for Cursor/Antigravity. Private token files identify agents and repo grants
limit their access. A connecting agent cannot impersonate another agent by choosing
a name, header or query parameter.

## Start and set up agents

```sh
cp product/.env.example product/.env
# Replace the placeholders with independently generated random values.
chmod 600 product/.env
docker compose --env-file product/.env up --build --wait
```

For an existing local PostgreSQL service, configure `DATABASE_URL` and
`BOOTSTRAP_SECRET` in the private `product/.env`, then:

```sh
npm ci --prefix product
npm run build --prefix product
npm run start:local --prefix product
```

Prepare a private operator JSON file using the [setup example](product/README.md#one-command-operator-setup-for-each-repository):

```sh
npm run setup:operator --prefix product -- --config /absolute/private/backend-setup.json
npm run setup:operator --prefix product -- --config /absolute/private/admin-ui-setup.json
```

Use the same project name and distinct repo/agent/token paths. Setup provisions
resources, stores credentials outside the repos, verifies MCP access, and merges
one selected IDE configuration with a single `coordination` server entry. Cursor
is the default; choose Antigravity explicitly. Recognized old coordination aliases
are replaced while unrelated MCP integrations are preserved.
Already enrolled agents can run `setup:agent`. Restart the IDE MCP connection after
setup. Neither a frontend nor manual database edits are needed.

All tools below use **the same MCP server** and `/mcp` endpoint. You do not need
a second local MCP server for shared context or file coordination. See the
[single-configuration example](product/README.md#one-mcp-configuration).

## Coordination tools

- Setup/discovery: `agent_setup`, `identity_get`, `agent_list`, `state_snapshot`.
- Tasks: `task_create`, `tasks_list/get`, `task_claim`, `task_update`, `task_comment`,
  `task_handoff`, plus dependency checks and versioned lifecycle history.
- Files: `reservation_acquire`, `reservation_release`, `file_reservations_list/get`.
- Context: `context_publish`, `shared_context_items_list/get`.
- Cross-repo requests: `request_create`, `request_clarify`, `request_decide`,
  `request_answer`, and scoped request/response list/get tools.
- Incremental changes: `events_poll` with a retained cursor.

SQL authorization and pagination bound reads. Transactions serialize conflicting
writes. Context is immutable and versioned; secret values are screened before
publication. Cross-repo responses require explicit approval and remain private.

Optional managed Docker jobs support start/pause/resume/cancel, isolated checkouts
and lease-enforced writes. Docker calls do not hold the global mutation lock.
External IDE filesystem writes remain cooperative; use OS isolation when needed.

See the [product runbook](product/README.md) for permissions, per-repo agent
instructions, API setup, import, backup/restore, validation and runtime configuration.

## Compatibility and development

The original trusted-local SQLite MCP server remains available at
[`tools/agent-coordination`](tools/agent-coordination/README.md). It supports
single-repo coordination and centrally stored workspace status/context across
repos without requiring PostgreSQL. It is retained for existing installations,
not a second server to configure alongside the central service. New setup uses
only `coordination` and migrates recognized old registrations.

Coding agents modifying this repository follow [AGENTS.md](AGENTS.md), including
the file ownership/reservation protocol. Product tests require a disposable
PostgreSQL database; `RUN_DOCKER_RUNTIME_TESTS=1` enables the real runtime gate.
`npm run test:compose --prefix product` checks a complete disposable headless stack.
