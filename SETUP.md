# Install Coordination MCP v1.5.2

Run setup yourself after installing the prerequisites below. Setup handles Node
dependencies, service secrets, the first account and global MCP configuration.

## 1. Prepare your computer

- Install **Node.js 24 or newer** and **Git**.
- Install and start **PostgreSQL 16 or newer**. Keep your PostgreSQL username and
  password available. Docker and `psql` are not required.
- Install the clients you plan to use: Codex, Claude Code, Grok Build, Cursor or
  Antigravity.

Check your prerequisites in a terminal:

```sh
node --version
git --version
```

On Windows, PostgreSQL normally runs as a Windows service. Confirm it is running
in Services or pgAdmin. PostgreSQL does not need to be on your terminal's PATH:
setup connects directly through its Node driver.

## 2. Get the source

Use your existing checkout, or clone the release:

```sh
git clone --branch v1.5.2 https://github.com/dadyutenga/mcp.git
cd mcp
```

You can also download and extract `mcp-1.5.2.zip` from the
[v1.5.2 release](https://github.com/dadyutenga/mcp/releases/tag/v1.5.2). Open a
terminal in the extracted directory containing `setup.mjs`.

## 3. Run setup

For Codex, Claude Code and Grok Build:

```sh
node setup.mjs --client codex,claude,grok
```

For all five supported clients:

```sh
node setup.mjs --client all
```

For interactive client selection, use `node setup.mjs` without arguments. The
older `--client both` option selects Cursor and Antigravity.

When prompted:

1. Accept `http://127.0.0.1:4310/mcp` for a local service.
2. Enter a workspace/project name. Use the same name for clients that should
   discover each other and collaborate.
3. Enter the PostgreSQL settings below. Press Enter to accept a default.

| Prompt                   | Default / what to enter                                              |
| ------------------------ | -------------------------------------------------------------------- |
| PostgreSQL host          | `127.0.0.1` for your computer, or your PostgreSQL server hostname/IP |
| PostgreSQL port          | `5432`                                                               |
| PostgreSQL database name | `coordination`, a dedicated database for this service                |
| PostgreSQL username      | `postgres`, or the PostgreSQL account you use                        |
| PostgreSQL password      | Your actual PostgreSQL password; input is hidden and has no default  |

The default database URL is:

```text
postgresql://postgres@127.0.0.1:5432/coordination
```

The password is collected separately. Setup constructs and saves the complete
connection URL safely, including passwords containing special characters.
The MCP service URL (`http://127.0.0.1:4310/mcp`) and PostgreSQL URL are different:
port 4310 serves MCP; port 5432 is your database server.

Setup verifies the PostgreSQL login and server version before saving settings.
If the named database is missing, it asks whether to create it. The supplied
PostgreSQL account needs database creation permission for that operation; an
account that owns an existing database can use that database instead.

It then starts the Node service in the background, waits for its readiness check,
creates the first Coordination account and configures your selected MCP clients.
Success is explicit:

```text
PostgreSQL connection verified (version 16).
Service health verified at http://127.0.0.1:4310/mcp.
READY: PostgreSQL and MCP service verified. Client connections configured.
```

For a new database, setup generates the Coordination operator password and prints
the private account file's location. For an existing Coordination database it
asks for the existing **Coordination owner** username/password. Those are separate
from your PostgreSQL credentials. Passwords and raw tokens are never printed.
Private service logs and PID information are saved beside the account file as
`service.log` and `service.json`. After a computer restart, rerun setup to restart
the service with the verified settings already saved in `product/.env`.

## 4. Reload and verify

Reload/enable the **coordination** MCP connection in each selected client, or
restart the client. Open the Git repository you want the agent to work in.

Ask your agent:

> Use the coordination MCP. Run workspace_status, then collaboration_list, and
> show me the registered repository and available collaborators.

Repository registration is automatic when the client supplies workspace roots.
If the client does not supply them, ask the agent to call:

```text
workspace_register({path: "D:/path/to/your/repository"})
```

Every registered repository stays active together. No `workspace_select` is
required. Reads cover all registered repositories; actions on existing tasks,
reservations and requests route by their IDs. New tasks and requests include the
source `repo_id` so the tool can use the correct repository identity.

Ask agents to check `collaboration_inbox` at startup and before work. Pending
incoming requests also appear as notices on ordinary tool replies, and target
agents receive request events through `events_poll`. An **online** badge means a
recent connection heartbeat; it does not confirm that the agent has read or
answered a request. MCP cannot wake an idle external editor agent.

Version and native client checks:

```sh
node setup.mjs --version
codex mcp get coordination
grok mcp list
```

For Claude Code, use `/mcp` to inspect the connection. Run only the commands for
clients installed on your computer. The local service also exposes JSON metadata
at `http://127.0.0.1:4310/`; its version should be `1.5.2`.

To update an existing checkout, run `git pull --ff-only`. Restart the local Node
service to load the new server code, then reload `coordination` in each client's
MCP settings once to load the new bridge. Existing credentials and database
history remain valid; no reinstall or database reset is required.

## Existing local PostgreSQL installation

If your previous installation used local PostgreSQL, its database and account
can be reused. Keep the PostgreSQL service running.

Run `node setup.mjs --client codex,claude,grok` and enter your PostgreSQL settings.
Setup starts the service automatically. If you already have a valid `product/.env`,
its saved PostgreSQL connection is verified and reused without asking for the
database password again.

After a local removal, you can restore `service/product.env` from the private
uninstall backup as `product/.env`, preserving private permissions. The existing
Coordination owner credentials are in the backup's
`credentials/operator-setup.json`. Open it privately when setup asks for the owner
login. Database history is preserved.

Setup issues fresh enrollment tokens. Previously revoked token files remain in
the archive for reference; restoring the service environment and entering the
operator credentials is sufficient to enroll the clients again.

## Connect to another running service

```sh
node setup.mjs --url https://your-service.example/mcp --client codex,claude,grok
```

Enter the service owner's credentials when prompted. The administrator supplies
the bootstrap secret if this is the service's first account. Remote services
require HTTPS. For automation or custom client configuration paths, see the
[product setup guide](product/README.md#global-setup-with-automatic-repository-registration).

## Troubleshooting

| Symptom                                        | Action                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `node` or `git` is not recognized              | Install it, then open a new terminal.                                                   |
| PostgreSQL cannot be reached                   | Start PostgreSQL; check its hostname/IP and port.                                       |
| PostgreSQL rejects the password                | Enter the actual PostgreSQL account password, separate from the Coordination login.     |
| Database creation is denied                    | Choose a database you own or use a PostgreSQL account with CREATEDB permission.         |
| The service uses local PostgreSQL              | Start it using the PostgreSQL steps above before rerunning setup.                       |
| Port 4310 is already in use                    | Connect to the existing coordination service, or stop the process using that port.      |
| MCP is missing in the client                   | Reload/restart the client and enable its global `coordination` entry.                   |
| No repository is registered                    | Use `workspace_register` with an absolute Git repository path.                          |
| Existing configuration is invalid or conflicts | Repair/review that file; setup preserves unrelated integrations and backs up originals. |

Removing client registrations and stopping the coordination service does not
delete source code, PostgreSQL data, or the legacy SQLite coordination history.
Private uninstall backups are stored outside the repository under
`~/.config/coordination-uninstalled/`.
