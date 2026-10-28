# Local Multi-Agent Coordination MCP

A local Model Context Protocol (MCP) workspace and coordination server that enables multiple coding agents—such as **Cursor** (`cursor-backend`) and **Google Antigravity** (`antigravity-frontend`)—to collaborate safely in a shared repository using a single local SQLite database.

No cloud service, Docker container, or external database is required. Each IDE launches its own stdio MCP server process pointing to the same repository root and SQLite WAL database.

---

## Key Features

- **Session-Bound Agent Identities**: Agents register a stable identity (`cursor-backend`, `antigravity-frontend`, etc.) that binds their stdio session for all write operations and survives IDE restarts via `state_snapshot`.
- **Task & Dependency Management**: Create, assign, atomically claim, update, block, and complete tasks with acceptance criteria, dependency cycle detection, and required verification evidence.
- **File Ownership & Atomic Reservations**: Enforce path-based ownership policies (`ownership-policy.json`) and time-limited exclusive write or shared read leases (`file_reserve`, `file_reserve_batch`) before editing files.
- **Cross-Agent Messaging & Change Requests**: Exchange durable, task-linked messages, API/contract change requests, and scoped file ownership approval requests (`file_ownership_request`).
- **Audit Trail & Concurrency Safety**: Backed by SQLite in WAL mode with immediate write transactions, foreign key enforcement, and a complete mutation audit log (`audit_list`).

---

## Repository Structure

```text
.
├── AGENTS.md                        # Multi-agent file ownership and reservation protocol rules
├── README.md                        # General project documentation
└── tools/
    └── agent-coordination/          # Local MCP server package
        ├── README.md                # Detailed MCP server & workflow documentation
        ├── ownership-policy.json    # Path ownership rules and lease duration settings
        ├── package.json             # Node.js >= 22 package configuration and scripts
        ├── src/
        │   ├── server.js            # MCP stdio server and tool registrations
        │   ├── core.js              # Agents, tasks, messages, change requests, and audit logic
        │   ├── files.js             # File ownership, conflict checks, and reservation leases
        │   ├── db.js                # SQLite connection, schema migrations, and project root resolution
        │   ├── paths.js             # Canonical repository path validation and glob matching
        │   ├── setup.js             # IDE MCP config generator (.cursor/mcp.json & .agents/mcp_config.json)
        │   └── cli.js               # Database health check and reset CLI
        └── test/                    # Unit, integration, and multi-process concurrency tests
```

Generated local state (ignored by Git):
- `.local/agent-coordination/coordination.sqlite` — Shared SQLite database created automatically on startup.
- `.cursor/mcp.json` — Local Cursor MCP server configuration.
- `.agents/mcp_config.json` — Local Google Antigravity MCP server configuration.

---

## Requirements & Quickstart

- **Node.js 22+** and **npm** (Windows, macOS, or Linux)

Install dependencies, configure both IDEs, and verify the SQLite database from `tools/agent-coordination`:

```powershell
cd tools/agent-coordination
npm ci
npm run setup
npm run db:check
```

After running `npm run setup`, restart or refresh the MCP servers in Cursor and Google Antigravity so they pick up the generated configuration.

### Using in Another Repository

Copy the `tools/agent-coordination` directory (excluding `node_modules`) into the target repository's `tools/agent-coordination` folder, then run `npm ci` and `npm run setup`. Customize `tools/agent-coordination/ownership-policy.json` to match your repository's directory layout.

---

## Agent Coordination Workflow

All participating agents follow the protocol defined in [`AGENTS.md`](AGENTS.md):

1. **Register & Recover State**: Call `agent_register` with a stable identity (`cursor-backend` or `antigravity-frontend`), then call `state_snapshot` and `file_coordination_status` to inspect open tasks, unread messages, and active file leases.
2. **Claim a Task**: Create or locate the target task and call `task_claim` before starting work.
3. **Check & Reserve Files**: Run `file_ownership_check` / `file_conflict_check` and acquire a lease with `file_reserve_batch` before modifying any files. If a file is owned by another agent, request scoped access via `file_ownership_request`.
4. **Maintain Leases**: Edit only files covered by an active reservation and renew leases (`file_reservation_renew`) during long-running work.
5. **Verify, Complete & Release**: Run tests, record modified files and verification evidence with `task_complete`, release reservations via `file_reservation_release`, and notify peers if needed.

---

## MCP Tools Overview

| Category | Tools |
| :--- | :--- |
| **Agents** | `agent_register`, `agent_list`, `agent_heartbeat`, `state_snapshot` |
| **Tasks** | `task_create`, `task_get`, `task_list`, `task_assign`, `task_claim`, `task_update`, `task_complete`, `task_dependency_add`, `task_dependency_remove` |
| **Messages** | `message_send`, `message_list`, `message_acknowledge` |
| **Change Requests** | `change_request_create`, `change_request_list`, `change_request_respond` |
| **File Coordination** | `file_ownership_check`, `file_reserve`, `file_reserve_batch`, `file_reservation_list`, `file_reservation_renew`, `file_reservation_release`, `file_conflict_check`, `file_conflict_list`, `file_ownership_request`, `file_ownership_respond`, `file_ownership_request_list`, `file_coordination_status` |
| **Audit** | `audit_list` |

---

## Testing & Maintenance

Run the test suites and database health checks from `tools/agent-coordination`:

```powershell
npm test
npm run test:integration
npm run test:concurrency
npm run db:check
```

To intentionally wipe all local coordination history (with all IDE MCP server processes stopped):

```powershell
npm run db:reset -- --yes-i-understand-this-deletes-coordination-data
```

For full details on policy matching rules, reservation lifecycles, and conflict recovery, see [`tools/agent-coordination/README.md`](tools/agent-coordination/README.md).
