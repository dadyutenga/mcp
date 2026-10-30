import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { database } from "../src/db.js";
import { app } from "../src/server.js";
import { provision } from "../src/operator-setup.js";
import { installAgent } from "../src/setup.js";
import { privateFile } from "../src/credentials.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("headless setup provisions two repos, keeps credentials private, and scopes peer/task coordination", async () => {
  const pool = await database(process.env.TEST_DATABASE_URL);
  await pool.query("TRUNCATE users CASCADE");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-setup-")),
    bootstrap = "setup-fixture-bootstrap-secret-at-least-32";
  const server = await app({
    pool,
    bootstrapSecret: bootstrap,
    runtimeConfig: null,
  });
  const clients = [];
  try {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const url = "http://127.0.0.1:" + server.server.address().port + "/mcp";
    const credentials = {
      url,
      username: "setup-owner",
      password: "setup-fixture-owner-password",
      bootstrap_secret: bootstrap,
      project: "Setup " + randomUUID(),
    };
    const inputs = [];
    for (const name of ["backend", "admin-ui"]) {
      const repo = path.join(root, name);
      await mkdir(repo);
      await mkdir(path.join(repo, ".cursor"));
      await writeFile(
        path.join(repo, ".cursor/mcp.json"),
        JSON.stringify({
          mcpServers: { existing: { command: "existing-tool" } },
        }),
      );
      const config = {
        ...credentials,
        repo: name,
        reference: repo,
        agent: name + " agent",
        repo_path: repo,
        token_file: path.join(root, "private", name + ".token"),
      };
      const configFile = path.join(root, name + "-operator.json");
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const execution = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../src/operator-setup.js", import.meta.url)),
        "--config",
        configFile,
      ]);
      assert.ok(
        !execution.stdout.includes(config.password) &&
          !execution.stdout.includes(bootstrap),
      );
      const setup = JSON.parse(execution.stdout);
      inputs.push({ config, setup });
      const token = (await readFile(config.token_file, "utf8")).trim();
      const cursor = await readFile(
          path.join(repo, ".cursor/mcp.json"),
          "utf8",
        ),
        antigravity = await readFile(
          path.join(repo, ".agents/mcp_config.json"),
          "utf8",
        );
      assert.ok(!cursor.includes(token) && !antigravity.includes(token));
      assert.equal(
        JSON.parse(cursor).mcpServers.existing.command,
        "existing-tool",
      );
      assert.equal(
        JSON.parse(cursor).mcpServers.coordination.env.COORDINATION_REPO_ID,
        setup.repo_id,
      );
      assert.match(
        await readFile(path.join(repo, ".gitignore"), "utf8"),
        /\.cursor\/mcp.json/,
      );
      const client = new Client({ name: "setup-" + name, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      clients.push(client);
    }
    assert.equal(inputs[0].setup.project_id, inputs[1].setup.project_id);
    assert.notEqual(inputs[0].setup.repo_id, inputs[1].setup.repo_id);
    const repeat = await provision(inputs[0].config);
    assert.equal(repeat.agent_id, inputs[0].setup.agent_id);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM agents WHERE id=ANY($1::uuid[])",
          [inputs.map((x) => x.setup.agent_id)],
        )
      ).rows[0].count,
      "2",
    );
    const call = async (c, name, args = {}) => {
      const result = await c.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent.result;
    };
    const task = await call(clients[0], "task_create", {
      input: {
        repo_id: inputs[0].setup.repo_id,
        title: "Coordinate backend work",
        description: "Created through MCP without a UI",
      },
    });
    assert.equal(task.assignee, inputs[0].setup.agent_id);
    const denied = await clients[0].callTool({
      name: "task_create",
      arguments: {
        input: {
          repo_id: inputs[1].setup.repo_id,
          title: "Must fail",
          description: "Outside grant",
        },
      },
    });
    assert.equal(denied.isError, true);
    const forged = await clients[0].callTool({
      name: "task_create",
      arguments: {
        input: {
          repo_id: inputs[0].setup.repo_id,
          assignee: inputs[1].setup.agent_id,
          title: "Must not assign other agents",
          description: "Scope check",
        },
      },
    });
    assert.equal(forged.isError, true);
    const snapshot = await call(clients[0], "state_snapshot");
    assert.ok(snapshot.tasks.items.some((t) => t.id === task.id));
    assert.ok(
      !snapshot.peers.items.some((p) => p.id === inputs[1].setup.agent_id),
    );
    const unknown = await clients[0].callTool({
      name: "agent_setup",
      arguments: { repo_id: inputs[1].setup.repo_id },
    });
    assert.equal(unknown.isError, true);
    const badFile = path.join(root, "bad.token");
    await writeFile(badFile, "invalid-token", { mode: 0o600 });
    const unconfigured = path.join(root, "untouched");
    await mkdir(unconfigured);
    await assert.rejects(
      installAgent({ repo: unconfigured, url, tokenFile: badFile }),
    );
    await assert.rejects(
      readFile(path.join(unconfigured, ".cursor/mcp.json")),
      /ENOENT/,
    );
    await chmod(inputs[0].config.token_file, 0o644);
    await assert.rejects(privateFile(inputs[0].config.token_file), /mode 600/);
    await chmod(inputs[0].config.token_file, 0o600);
    await provision({ ...inputs[0].config, permissions: ["task:read"] });
    const nowReadOnly = await clients[0].callTool({
      name: "task_create",
      arguments: {
        input: {
          repo_id: inputs[0].setup.repo_id,
          title: "Must be denied after grant update",
          description: "No create grant",
        },
      },
    });
    assert.equal(nowReadOnly.isError, true);
    const linked = path.join(root, "linked-private");
    await symlink(inputs[0].config.repo_path, linked);
    await assert.rejects(
      provision({
        ...inputs[0].config,
        token_file: path.join(linked, "must-not-leak.token"),
      }),
      /outside the repository/,
    );
    await assert.rejects(
      readFile(path.join(inputs[0].config.repo_path, "must-not-leak.token")),
      /ENOENT/,
    );
    const inside = path.join(inputs[0].config.repo_path, "secret.token");
    await writeFile(inside, "must-not-be-used", { mode: 0o600 });
    await assert.rejects(
      installAgent({
        repo: inputs[0].config.repo_path,
        url,
        tokenFile: inside,
      }),
      /outside the repository/,
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await server.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
