# MCP Agent Coordination v1.5

A **headless coordination service** for agents working across two or more repositories.
Agents connect through MCP to share work status, coordinate tasks and file leases,
publish versioned context, request scoped help, and discover authorized peers.
There is no frontend or browser setup.

The central product uses PostgreSQL, authenticated Streamable HTTP MCP and a stdio
bridge for Cursor, Antigravity, Codex, Claude Code and Grok Build. Private token files identify agents and repo grants
limit their access. A connecting agent cannot impersonate another agent by choosing
a name, header or query parameter.

## First-time setup

Follow the **[step-by-step setup instructions](SETUP.md)** to install it yourself.
The guide includes a fresh Docker installation, reuse of local PostgreSQL,
client verification, and reinstalling after removing an earlier installation.

Install **Node.js 24+** and **Git**. For a new local service, also install and start
Docker Desktop (or Docker Engine with Compose). Then:

```sh
git clone https://github.com/dadyutenga/mcp.git
cd mcp
node setup.mjs
```

Setup installs Node dependencies and asks which editor to connect and what to
call your workspace. Accept the default service URL to run locally. It generates
the service secrets, starts Docker, creates the first operator account, and
installs **global** MCP configuration for your selected clients. No JSON
or `.env` editing is required. First-time Docker image downloads/builds can take
a few minutes.

Select one client, several clients, or all five:

```sh
node setup.mjs --client codex,claude,grok
node setup.mjs --client all
```

| Client      | Global configuration                    |
| ----------- | --------------------------------------- |
| Cursor      | `~/.cursor/mcp.json`                    |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
| Codex       | `~/.codex/config.toml`                  |
| Claude Code | `~/.claude.json`                        |
| Grok Build  | `~/.grok/config.toml`                   |

Setup preserves unrelated settings and MCP servers, and saves an original
configuration backup before modifying an existing file. `claude-code` and
`grok-build` are also accepted client names. The older `--client both` continues
to select Cursor and Antigravity.

Reload/enable **coordination** in your editor's MCP settings once. Open any Git
repository: its repository record and agent identity register automatically.
Agents use `collaboration_list` to discover repositories and request help from the
right one. No MCP configuration is needed inside each repository. Clients that
do not provide workspace roots can call `workspace_register` with the repo path.

Private account details and enrollment tokens are saved outside Git under
`~/.config/agent-coordination/installations/`. Setup prints the account file path,
never its password. Keep that file private; rerunning setup reuses it. Docker
restarts the service when Docker starts again. Agents connect while the service
and their editor MCP connection are running; external agents receive work by
polling MCP.

Already have a service? Supply its URL; Docker is not needed on this computer:

```sh
node setup.mjs --url https://coordination.example/mcp --client cursor
```

For an existing service without saved credentials, setup asks for the owner login
with hidden password entry. Connecting to a fresh remote service also requires
its bootstrap secret. Run `node setup.mjs --help` for options.

See [global setup](product/README.md#global-setup-with-automatic-repository-registration)
for manual configuration, automation and additional MCP clients.

Download the [v1.5.0 release](https://github.com/dadyutenga/mcp/releases/tag/v1.5.0)
or read the [changelog](CHANGELOG.md). Existing checkouts can update with
`git pull --ff-only`, then rerun setup for any additional clients. Existing tokens,
repository registrations and database records are retained. Check the installed
version with `node setup.mjs --version`.

## Manual service setup

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

Then run `node setup.mjs` to connect your editors globally. The existing
[repository-scoped setup](product/README.md#one-command-operator-setup-for-each-repository)
remains available for older installations and deliberately restricted connections.

All tools below use **the same MCP server** and `/mcp` endpoint. You do not need
a second local MCP server for shared context or file coordination. See the
[single-configuration example](product/README.md#one-mcp-configuration).

## Coordination tools

- Setup/discovery: `workspace_register`, `workspace_status`, `workspace_select`,
  `collaboration_list`, `agent_setup`, `identity_get`, `agent_list`, `state_snapshot`.
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
