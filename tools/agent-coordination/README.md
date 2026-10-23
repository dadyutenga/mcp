# Local agent coordination MCP server

This service lets independent Cursor and Google Antigravity agents coordinate through one local SQLite database. Each IDE starts its own Node.js MCP stdio process. Both processes resolve the same project root and database, regardless of their working directory. It also coordinates file ownership and time-limited reservations.

## Requirements and installation

- Windows, macOS, or Linux with Node.js 22 or newer and npm.
- No cloud service, Docker container, or hosted database.

Keep this package at `tools/agent-coordination` in the project that the agents share. From that directory:

```powershell
npm ci
npm run setup
npm run db:check
```

`setup` merges a `local-agent-coordination` entry into the project's `.cursor/mcp.json` and `.agents/mcp_config.json`. It preserves other MCP entries and refuses to replace an entry with the same name but different settings. Both entries call the same server script by absolute path. It adds database, `node_modules`, and generated IDE config ignore rules to the project `.gitignore` if missing. The IDE config files stay local because their absolute paths depend on the machine. Restart or refresh each IDE's MCP servers after setup. [Cursor's project MCP configuration](https://docs.cursor.com/context/model-context-protocol) uses `.cursor/mcp.json`; [Google Antigravity's workspace configuration](https://antigravity.google/docs/mcp) uses `.agents/mcp_config.json`.

To use this in another repository, copy the whole `tools/agent-coordination` directory **without `node_modules`**, run `npm ci` and `npm run setup` there. The package lockfile pins the tested dependencies. Re-run `setup` if the repository or Node executable moves. The service resolves the project root three levels above `src/db.js`; alternatively, set `AGENT_COORDINATION_PROJECT_ROOT` to an existing directory for a deliberate shared location.

## Agent workflow

Use a stable ID such as `cursor-backend` or `antigravity-frontend` every time the IDE starts:

1. Call `agent_register` with the stable ID, role, and capabilities. The first registration binds that MCP stdio session to the ID for all write tools. Re-register the same ID after a restart.
2. Call `state_snapshot` and `file_coordination_status` to recover tasks, inbox, file leases, requests, and conflicts.
3. Use `task_create` and `task_assign` for handoffs. The intended owner calls `task_claim` before work. A task can have only one claimant.
4. Identify intended files. Call `file_conflict_check`, then `file_reserve_batch` before editing. The check is read-only and its result can become stale; only a successful reservation grants the coordination lease.
5. Use `task_update` for progress and blockers. Use `task_dependency_add` for prerequisite tasks. Renew leases for long work; stop and coordinate if a reservation is denied.
6. Use `message_send` for persistent information and `change_request_create` for a requested API or integration change. Use `file_ownership_request` for a file owned by the other agent. Recipients acknowledge or respond through MCP.
7. Run relevant tests, record changed files and verification evidence in `task_complete`, release each reservation, and notify affected agents. Clear blockers and resolve critical file conflicts before completion. Call `agent_heartbeat` during long sessions if last seen information matters.

The server exposes only coordination operations. It does not edit source code, run project commands, or send network requests. Session binding stops an already bound MCP process from claiming another agent ID through tools. Initial registration is self-asserted; this is cooperative coordination, not cryptographic authentication against a local adversary.

## File ownership policy

Edit `ownership-policy.json` to match each repository's actual layout, then restart both MCP processes. This starter repository has no backend or frontend application tree, so the file includes conventional `backend/**` and `frontend/**` examples and defaults unmatched paths to `shared`. It marks `shared/**`, root JSON files, `AGENTS.md`, and `tools/agent-coordination/**` as shared. Shared ownership means either agent may request a reservation; it never means simultaneous exclusive edits are allowed.

Policy rules are evaluated in order, with the **last matching rule winning**. Patterns are anchored to the repository root. `*` matches zero or more characters within one path segment; `**` matches across segments, and `**/` also matches zero segments. Matching is case-insensitive. An invalid policy stops startup. Owners must be a stable agent ID or `shared`; an agent named in a policy must register before it can receive an ownership request.

Repository file targets must be relative, such as `backend/src/api.ts`. Both `/` and `\` separators become `/`; comparison keys are lowercase, so `FRONTEND/src/App.tsx` and `frontend\src\app.tsx` conflict even on a case-sensitive test filesystem. Absolute paths, drive paths, UNC paths, `..`, invalid Windows names, and existing symlink or junction components are rejected. The service does not read or modify requested source files.

## Reservation and approval lifecycle

`file_reserve` and `file_reserve_batch` require a claimed, active task. Exclusive writes conflict with any other active reservation on the same canonical path; shared reads may coexist with other shared reads. Repeating an identical reservation returns its existing ID. A batch validates every path, deduplicates aliases, checks all conflicts under one SQLite immediate write transaction, and creates **none** of the requested leases if any path fails. A denied attempt returns `acquired: false` with a human-readable conflict report and stores deduplicated conflict events and messages. Read-only checks create no notifications and grant no lease.

The default lease is 15 minutes; the maximum renewal duration is 60 minutes. Both values are in the policy file. SQLite computes UTC lease times. `file_reservation_renew` accepts only the holder of a live lease; `file_reservation_release` accepts only the holder and is idempotent after release. Expired leases are invalid immediately, even before a later write marks them expired. A reservation obtained after a lease expired includes a stale-writer warning for recent expired leases. Confirm that the previous editor stopped before editing. Lease history and audit events remain after release or expiration.

For an agent-owned file, the other agent sends `file_ownership_request` with a claimed task, reason, and expected changes. The policy owner receives a durable task-linked message and reads the full request through `file_ownership_request_list`. `file_ownership_respond` approves or rejects it. Approval is limited to the requester, that exact file, that exact task, and an expiration time; it only permits a later reservation attempt. The existing holder's reservation still blocks the approved requester. Rejection requires a reason. The policy's `approvalSeconds` controls approval lifetime. Shared files need no approval, but still require reservations. Notifications include identifiers and actions, not user-supplied source text.

### Example: both agents need one backend file

1. Cursor registers as `cursor-backend`, claims its API task, and reserves `backend/src/routes/customers.ts`.
2. Antigravity registers as `antigravity-frontend`, claims its UI task, and calls `file_reserve` for the same path. The response is `acquired: false` with `ACTIVE_WRITE_RESERVATION` and `OWNERSHIP_VIOLATION`; Cursor receives durable conflict messages linked to the UI task.
3. Antigravity sends `file_ownership_request`. Cursor sees it in `message_list` and approves. Antigravity tries again and still receives `ACTIVE_WRITE_RESERVATION`.
4. Cursor releases its lease. Antigravity reserves the file under the scoped approval. Both transitions are visible in `audit_list` and `file_reservation_list`.

This exact sequence is exercised through two independent MCP stdio processes in `test/file-mcp.test.js`.

## Conflicts and recovery

`file_conflict_check` is a preview; its `safe_to_proceed` value means the agent may **attempt** a reservation. Another process can reserve after the check and before `file_reserve`. The reservation transaction is the authoritative decision. `file_conflict_list` shows open and resolved events. `file_coordination_status` summarizes active and expired leases, policy violations, pending approvals, shared-area editors, and tasks with critical conflicts. Task completion rejects unresolved critical conflicts associated with that task; it does not claim reservation evidence when none exists.

After an IDE restart, register the same ID, call `state_snapshot`, `file_reservation_list`, and `file_coordination_status`, then renew any still-active lease you will use. If a holder disappeared, wait for its lease to expire, confirm it stopped editing, and reserve again. If the policy owner is unavailable, coordinate through a linked task or wait for that agent to register; do not change the SQLite database directly to bypass ownership. For an abandoned task, its creator can cancel it through `task_update`. The database reset command below is a deliberate destruction of *all* coordination history and is not a lease recovery tool.

**The MCP service enforces reservations inside its own coordination operations. Direct IDE filesystem writes remain possible unless separately controlled.** Participating agents must follow `AGENTS.md` and the workflow above.

## Tools

| Area | MCP tools |
| --- | --- |
| Agents | `agent_register`, `agent_list`, `agent_heartbeat`, `state_snapshot` |
| Tasks | `task_create`, `task_get`, `task_list`, `task_assign`, `task_claim`, `task_update`, `task_complete`, `task_dependency_add`, `task_dependency_remove` |
| Messages | `message_send`, `message_list`, `message_acknowledge` |
| Change requests | `change_request_create`, `change_request_list`, `change_request_respond` |
| Files | `file_ownership_check`, `file_reserve`, `file_reserve_batch`, `file_reservation_list`, `file_reservation_renew`, `file_reservation_release`, `file_conflict_check`, `file_conflict_list`, `file_ownership_request`, `file_ownership_respond`, `file_ownership_request_list`, `file_coordination_status` |
| History | `audit_list` |

All IDs for tasks, messages, change requests, and audit events are UUIDs. Agent IDs are stable caller-supplied names. Timestamps are UTC ISO 8601 strings. Priority is 1–5, with 5 highest. Progress is 0–99 until completion, which sets it to 100. `task_claim` is atomic across independent processes. A task creator controls assignment and dependency changes; a claimant controls completion. A change request recipient controls its response.

## Database and maintenance

The database is `<project-root>/.local/agent-coordination/coordination.sqlite`. Startup creates it if needed and applies versioned migrations. Migration 2 adds `file_reservations`, `file_conflicts`, and `ownership_requests` without rebuilding the earlier tables. SQLite WAL, foreign keys, a 5-second busy timeout, and immediate write transactions protect concurrent processes. Audit events are written in the same transaction as each important mutation. The database survives IDE and server restarts.

```powershell
npm test
npm run test:integration
npm run test:concurrency
npm run db:check
```

Back up the database with SQLite's online backup API or while both IDE MCP processes are stopped. To deliberately destroy all coordination data, stop both IDE MCP processes, then run:

```powershell
npm run db:reset -- --yes-i-understand-this-deletes-coordination-data
```

Reset without that exact flag is refused. Ordinary startup never resets the database.

## Troubleshooting

- If tools do not appear, refresh MCP servers in both IDEs and inspect `.cursor/mcp.json` and `.agents/mcp_config.json` for the generated absolute Node and script paths.
- If one IDE sees different tasks, check that both MCP entries point to the same server script or explicitly use the same `AGENT_COORDINATION_PROJECT_ROOT` environment value.
- Run `npm run db:check` to inspect schema version, WAL mode, integrity, foreign key violations, and row counts.
- If an existing configuration contains comments or invalid JSON, `setup` stops before changing either MCP file. Merge the documented server entry manually.
