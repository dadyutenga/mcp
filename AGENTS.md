# Multi-Agent File Ownership and Reservation Protocol

When working in this repository as a coding agent, read [the coordination workflow](tools/agent-coordination/README.md) before changing files.

1. Register one stable identity for this MCP session (`cursor-backend` or `antigravity-frontend`), read your inbox, and claim the task you will perform.
2. Identify the intended files. Check ownership and conflicts, then acquire `file_reserve_batch` for all of them before editing. A read-only check does not hold a reservation.
3. Edit only files covered by your live reservation. Respect reservations held by another agent, including on shared files. If a conflict or unexpected file change appears, stop and coordinate through a linked task, message, or scoped `file_ownership_request`.
4. Renew reservations during long work. Treat an expired lease as possible stale editing activity and verify the previous editor stopped before proceeding.
5. After testing, record changed files and verification evidence in task completion, release your reservations, and notify affected agents. Release reservations when abandoning work as well.

Use the MCP tools for reservation changes; keep the coordination database intact and use the documented recovery procedure when a lease is stuck.
