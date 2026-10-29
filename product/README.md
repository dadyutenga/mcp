# Coordination product — local control plane

This additive product preserves `tools/agent-coordination` unchanged. That legacy
stdio service remains a trusted, self-asserted local protocol. The product is a
**separate** PostgreSQL installation: its HTTP API and authenticated MCP adapters
share one domain service. Never expose the legacy server as an authenticated
central service.

## Run locally

Requires Docker Compose. From the repository root:

```sh
cp product/.env.example product/.env
# Replace BOTH placeholders with independently generated random hex strings:
openssl rand -hex 32
openssl rand -hex 32
docker compose --env-file product/.env up --build --wait
```

Open http://127.0.0.1:4310. First-run setup requires BOOTSTRAP_SECRET plus a username
and a new password of at least 12 characters. There is no default owner password.
Bootstrap is disabled after the first owner is created. Passwords use Argon2id;
12-hour sessions use hash-only random tokens, HttpOnly/SameSite=Strict cookies and
CSRF headers. Set SECURE_COOKIES=true behind TLS. The example secret is rejected.
Never commit `.env`, enrollments or backups.

Compose publishes only loopback. PostgreSQL has no published port. Do not expose
this release publicly. The container's explicit internal bind is for Compose
networking, not authorization to publish an Internet endpoint. Remote deployments
need an operator-managed TLS boundary, a separate deployment review, and tighter
host/origin policy. No agent runtime or worktree adapter is implemented. All file
leases are explicitly advisory; an external IDE cannot be paused or prevented
from writing files. Stale connections use heartbeat timestamps. Disconnect does
not cancel a task; its leases naturally expire within their 30–3600 second TTL.
Completion/cancellation releases active task leases.

Corporate/managed proxy builds can pass their public CA bundle without putting it
in image layers:

```sh
docker build --secret id=proxy_ca,src=/path/to/ca-bundle.pem -t coordination-product .
docker compose --env-file product/.env up --no-build --wait
```

Ordinary local builds do not require this mount. TLS/checksum verification stays
enabled. The build stage contains native compilers for better-sqlite3; the runtime
runs as the unprivileged `node` user.

## Workflow and agent connection

1. Create a project, then repository records (references are metadata, never
   automatically cloned or indexed).
2. Enroll each agent with explicitly selected repo grants/permissions. Copy its
   token once. List tokens for prefix/expiry, rotate agent credentials, or revoke a
   token from **More actions**. Owner-only grants can be updated/revoked by supplying
   an empty permission set. All effective permissions are checked server-side.
3. Create/assign tasks, use versioned task updates, dependencies, review/done and
   cancellation. Stale updates return 409. Agents atomically claim tasks using MCP.
4. For cross-repo information, create a request naming exact scope and purpose.
   Only the owner or a target-repo `cross_repo:approve` agent can approve or answer.
   Approval applies to that request only. Answers go to the requester, not every
   source repo member. Context sharing beyond the publishing repo is owner-only.
5. Review events, grants and advisory leases in the panel. The event feed reconnects
   with stable audit IDs; audit rows and outbox entries commit with domain changes.

New authenticated tools include `identity_get`, `tasks_list`, `task_claim`,
`task_update`, `reservation_acquire`, `reservation_release`, `request_create`,
`request_decide`, `request_answer`, `shared_context_items_list`, and `events_poll`.
Action tools take `{input: {...}}`; the principal always comes from the bearer
credential, never `agent_id` in arguments. Writes use strict schemas. Read replies
are paged and byte-bounded. Use returned next_cursor as after until has_more=false.

Stdio MCP configuration (placeholders only, token outside source control):

```json
{"mcpServers":{"coordination-product":{
  "command":"node",
  "args":["/absolute/path/to/mcp/product/src/bridge.js"],
  "env":{"COORDINATION_URL":"http://127.0.0.1:4310/mcp",
         "COORDINATION_AGENT_TOKEN":"<your individually enrolled token>"}
}}}
```

For clients supporting Streamable HTTP, connect directly to `/mcp` with an
`Authorization: Bearer <token>` header. Non-loopback bridge destinations require
HTTPS. The new central tool contracts intentionally differ from the legacy local
mode; existing local names/behavior continue at the old entrypoint.

## Development and verification

```sh
cd product
npm ci
npm run build
# Must be a DISPOSABLE DB: tests truncate product tables.
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/disposable npm test
# Browser test uses /usr/bin/chromium, override with CHROMIUM_PATH if needed.
cd ../tools/agent-coordination
npm test
```

The product suite exercises owner bootstrap/login/CSRF, actual HTTP MCP clients
for two scoped agents, a real stdio bridge, cross-repo approval/answer, denied
self-approval and forged IDs, revoked/expired credentials, task and path races,
optimistic concurrency, audit immutability, restart persistence, safe SQLite import,
and a Chromium browser login/create-project/mobile-navigation workflow. Tests run
serially. No external provider credentials or real repositories are used.

## Backup, restore and legacy import

Create a full PostgreSQL backup before upgrade or import:

```sh
docker compose --env-file product/.env exec -T db pg_dump -U coordination -Fc coordination > coordination.dump
# Restore into a NEW empty database, never over a live installation:
docker compose --env-file product/.env exec -T db createdb -U coordination restored
docker compose --env-file product/.env exec -T db pg_restore -U coordination -d restored < coordination.dump
```

Keep backups private. To use the restored DB, intentionally update DATABASE_URL
and recreate the app. Restore tests on disposable PostgreSQL retained owner,
tasks, answers and audit history. New schema migrations are forward-only; rollback
means restoring a pre-upgrade backup and running the old release, not deleting data.

The import CLI runs on the host with DATABASE_URL pointing to the product DB. A
consistent SQLite online backup is created **before inspection or import**; source
files are opened read-only. Dry-run is the default:

```sh
cd product
npm run import -- --source=/absolute/legacy.sqlite --source-id=backend-legacy --backups=/private/backups
# Create the destination project/repo in the panel, inspect the dry-run, then:
npm run import -- --source=/absolute/legacy.sqlite --source-id=backend-legacy --backups=/private/backups --repo=DESTINATION_REPO_UUID --apply=true
```

Imports retain complete source rows in a private owner-only archive. Legacy tasks,
identities, dependencies and leases become product records. Agents are revoked and
untrusted until freshly enrolled; leases are expired, never resurrected. Existing
UUIDs are preserved; string identities get deterministic source-scoped mappings.
Collisions stop the transaction. Repeating the same source-id/content is idempotent;
a changed source under that ID stops for review. The original local mode remains
a rollback option because the source databases are unchanged.

**Migration limitation:** historical messages, approvals, audit, and workspace
events are archived as history, not converted into active central approvals,
reusable grants, or automatically shared context. Workspace-to-multiple-target-repo
mapping needs an explicit reviewed conversion before use. Do not treat archive
retention as full semantic migration of every legacy workflow.

## Implementation map and release review

- `src/db.js`: PostgreSQL pool, forward migrations, FK/index constraints and audit
  mutation protection. Flexible resource bodies are JSONB envelopes; service rules
  enforce lifecycle/authorization and transaction-scoped advisory locks serialize
  competing writes. This favors correctness for one operator over high throughput.
- `src/service.js`: common authorization, scope filters, workflows, audit/outbox.
- `src/server.js`: Fastify owner API, sessions/CSRF, SSE, authenticated HTTP MCP.
- `src/mcp.js`, `src/bridge.js`: authenticated tools and local stdio bridge.
- `src/import.js`: read-only legacy backup/inspection/idempotent import.
- `web/src`: responsive React/TypeScript panel backed by actual API data.

This is **not a completed release against every scenario in the supplied full
product specification**. Remaining release work includes richer typed resource
schemas and per-field SQL constraints, a full migration mapping/reconciliation UI,
explicit notification read state, comprehensive idempotency-payload conflict checks,
SSE resync/retention tests, security hardening/failure-audit coverage, and a full
browser acceptance test that performs every agent/approval action through the
Compose stack. The existing browser test covers a real but narrower workflow; API
restart persistence was tested, not a complete every-screen Compose restart flow.
No runtime adapter or automatic worktree creation is claimed. The product is local
only; do not use these passing tests as a public-deployment security review.
