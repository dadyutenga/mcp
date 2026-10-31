# Install Coordination MCP v1.5

Run setup yourself after installing the prerequisites below. Setup handles Node
dependencies, service secrets, the first account and global MCP configuration.

## 1. Prepare your computer

- Install **Node.js 24 or newer** and **Git**.
- For a new local service, install **Docker Desktop** on Windows/macOS, or Docker
  Engine with Compose on Linux. Start Docker before running setup.
- Install the clients you plan to use: Codex, Claude Code, Grok Build, Cursor or
  Antigravity.

Check your prerequisites in a terminal:

```sh
node --version
git --version
docker info
```

Docker is needed for a new local service. A client connecting to an already
running service does not need Docker. The existing PostgreSQL option below also
works without Docker.

## 2. Get the source

Use your existing checkout, or clone the release:

```sh
git clone --branch v1.5.0 https://github.com/dadyutenga/mcp.git
cd mcp
```

You can also download and extract `mcp-1.5.0.zip` from the
[v1.5.0 release](https://github.com/dadyutenga/mcp/releases/tag/v1.5.0). Open a
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
3. Answer `y` to start the local service with Docker if it is not running.

The first Docker download/build may take a few minutes. Setup generates database
and bootstrap secrets, creates the first operator account, and configures each
selected client globally. It prints the location of the private account file;
passwords and raw tokens are not printed. Keep that file for future setup runs.

A new Docker installation creates its own database. Use the existing PostgreSQL
option below to continue using earlier coordination history.

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

For a workspace with multiple repositories, use `workspace_select` with an ID
from `workspace_status` before actions that do not include a repository ID.
Agents receive collaboration requests when they use/poll their MCP connection.

Version and native client checks:

```sh
node setup.mjs --version
codex mcp get coordination
grok mcp list
```

For Claude Code, use `/mcp` to inspect the connection. Run only the commands for
clients installed on your computer. The local service also exposes JSON metadata
at `http://127.0.0.1:4310/`; its version should be `1.5.0`.

## Existing local PostgreSQL installation

If your previous installation used local PostgreSQL, its database and account
can be reused. Keep the PostgreSQL service running.

1. Restore the saved service environment to `product/.env`. After a local removal,
   the private backup contains `service/product.env`. Copy that file back as
   `product/.env`, preserving its private permissions.
2. In the checkout, start the service in a separate terminal:

   ```sh
   npm ci --prefix product
   npm run start:local --prefix product
   ```

3. In your first terminal, run `node setup.mjs --client codex,claude,grok`.
4. Accept the local service URL and enter the existing operator username/password
   when asked. After a local removal, those details are in the private backup at
   `credentials/operator-setup.json`. Open it privately on your computer.

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
| Docker is unavailable or cannot connect        | Install/start Docker Desktop or Docker Engine, then rerun setup.                        |
| The service uses local PostgreSQL              | Start it using the PostgreSQL steps above before rerunning setup.                       |
| Port 4310 is already in use                    | Connect to the existing coordination service, or stop the process using that port.      |
| MCP is missing in the client                   | Reload/restart the client and enable its global `coordination` entry.                   |
| No repository is registered                    | Use `workspace_register` with an absolute Git repository path.                          |
| Existing configuration is invalid or conflicts | Repair/review that file; setup preserves unrelated integrations and backs up originals. |

Removing client registrations and stopping the coordination service does not
delete source code, PostgreSQL data, or the legacy SQLite coordination history.
Private uninstall backups are stored outside the repository under
`~/.config/coordination-uninstalled/`.
