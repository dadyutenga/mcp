# Changelog

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
