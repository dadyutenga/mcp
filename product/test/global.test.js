import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hash as passwordHash } from "@node-rs/argon2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { database } from "../src/db.js";
import { Service } from "../src/service.js";
import { app } from "../src/server.js";
import { connectAgent } from "../src/workspaces.js";
import { installGlobal, provisionGlobal } from "../src/global-setup.js";

test("global enrollment, automatic MCP roots, repository isolation and collaboration", async (t) => {
  const pool = await database(process.env.TEST_DATABASE_URL);
  const service = new Service(pool),
    owner = { owner: true, id: randomUUID() };
  const server = await app({
    pool,
    bootstrapSecret: "global-fixture-bootstrap-at-least-32-characters",
    runtimeConfig: null,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-global-"));
  const clients = [];
  try {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(`http://127.0.0.1:${server.server.address().port}/mcp`);
    const project = await service.execute(owner, "project_create", {
      name: "Global " + randomUUID(),
    });
    const installation = await service.execute(owner, "installation_create", {
      project_id: project.id,
      name: "Cursor",
    });
    const enrollment = await service.authenticate(installation.token);
    const tokenFile = path.join(root, "enrollment.token");
    await writeFile(tokenFile, installation.token, { mode: 0o600 });
    const repos = [];
    for (const name of ["backend", "frontend"]) {
      const directory = path.join(root, name);
      await mkdir(directory);
      await promisify(execFile)("git", ["init", directory]);
      repos.push(directory);
    }
    let registered;
    await t.test(
      "enrollment is restricted, repeat registration is stable, peers can discover and request another repo",
      async () => {
        await assert.rejects(service.identity(enrollment), /only register/);
        await assert.rejects(
          service.execute(enrollment, "project_create", { name: "Denied" }),
          /only register/,
        );
        const otherProject = await service.execute(owner, "project_create", {
          name: "Other " + randomUUID(),
        });
        const hidden = await service.execute(owner, "repo_create", {
          project_id: otherProject.id,
          name: "Hidden",
          reference: "private:other",
        });
        const register = (reference, client) =>
          service.registerWorkspace(enrollment, {
            name: path.basename(reference),
            reference,
            client,
          });
        const [a, repeated] = await Promise.all([
          register(repos[0], "cursor"),
          register(repos[0], "cursor"),
        ]);
        assert.equal(a.agent_id, repeated.agent_id);
        assert.equal(a.repo_id, repeated.repo_id);
        assert.notEqual(a.token, repeated.token);
        const b = await register(repos[1], "antigravity");
        const secondAgent = await register(repos[0], "antigravity");
        assert.notEqual(a.agent_id, secondAgent.agent_id);
        const pa = await service.authenticate(a.token),
          pb = await service.authenticate(b.token);
        const directory = await service.collaboration(pa);
        assert.equal(directory.items.length, 2);
        assert.ok(!directory.items.some((r) => r.repo_id === hidden.id));
        assert.equal(
          directory.items.find((r) => r.repo_id === a.repo_id).agents.length,
          2,
        );
        assert.ok(
          (await service.events(pa)).some(
            (e) =>
              e.action === "workspace_agent_registered" &&
              e.repo_id === b.repo_id,
          ),
        );
        assert.equal((await service.read(pa, "repositories")).items.length, 1);
        await assert.rejects(
          service.execute(pa, "task_create", {
            repo_id: b.repo_id,
            title: "Denied",
            description: "Cross-repo writes must fail",
          }),
          /Permission/,
        );
        await assert.rejects(
          service.registerWorkspace(pa, {
            name: "Denied",
            reference: repos[0],
            client: "forged",
          }),
          /installation credential/,
        );
        const request = await service.execute(pa, "request_create", {
          repo_id: a.repo_id,
          target_repo: b.repo_id,
          type: "api-contract",
          reason: "Coordinate login",
          scope: "POST /api/v1/auth/login response fields",
        });
        const inbox = await service.read(pb, "cross_repo_requests");
        assert.ok(inbox.items.some((r) => r.id === request.id));
        await service.execute(pb, "request_decide", {
          id: request.id,
          decision: "approved",
          reason: "Share the login contract",
        });
        await service.execute(pb, "request_answer", {
          id: request.id,
          content: "Login returns access_token and refresh_token field names.",
        });
        assert.ok(
          (await service.read(pa, "cross_repo_responses")).items.length,
        );
        registered = { a, b, pa, pb };
      },
    );
    await t.test(
      "one global config preserves other integrations and writes no repository config",
      async () => {
        const home = path.join(root, "home");
        await mkdir(path.join(home, ".cursor"), { recursive: true });
        const config = path.join(home, ".cursor", "mcp.json");
        await writeFile(
          config,
          JSON.stringify({
            mcpServers: { github: { command: "existing-tool" } },
          }),
        );
        const result = await installGlobal({ home, tokenFile, url: url.href });
        assert.deepEqual(result.configurations, [config]);
        const output = await readFile(config, "utf8");
        assert.ok(!output.includes(installation.token));
        const installed = JSON.parse(output);
        assert.equal(installed.mcpServers.github.command, "existing-tool");
        assert.equal(
          installed.mcpServers.coordination.env.COORDINATION_REPO_ID,
          undefined,
        );
        for (const repo of repos)
          assert.deepEqual(await readdir(repo), [".git"]);
        const workerToken = path.join(root, "worker.token");
        await writeFile(workerToken, registered.a.token, { mode: 0o600 });
        await assert.rejects(
          installGlobal({ home, tokenFile: workerToken, url: url.href }),
          /enrollment credential/,
        );
        await assert.rejects(
          installGlobal({
            home,
            tokenFile,
            url: url.href,
            configFile: path.join(root, "outside.json"),
          }),
          /within your home/,
        );
        const username = "global-" + randomUUID();
        await pool.query(
          "INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)",
          [
            randomUUID(),
            username,
            await passwordHash("global-fixture-password"),
          ],
        );
        const input = {
          username,
          password: "global-fixture-password",
          project: project.name,
          url: url.href,
          client: "antigravity",
          token_file: path.join(root, "antigravity.token"),
        };
        const created = await provisionGlobal(input, { home });
        assert.ok(created.automatic_registration);
        assert.deepEqual(await provisionGlobal(input, { home }), created);
        await assert.rejects(
          provisionGlobal(
            { ...input, project: "Different " + randomUUID() },
            { home },
          ),
          /another project/,
        );
      },
    );
    await t.test(
      "stdio bridge registers MCP roots, handles root changes, and routes by repository",
      async () => {
        let roots = [{ uri: pathToFileURL(repos[0]).href }];
        const client = new Client(
          { name: "roots-fixture", version: "1" },
          { capabilities: { roots: { listChanged: true } } },
        );
        client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL("../src/bridge.js", import.meta.url))],
            cwd: root,
            env: {
              ...process.env,
              COORDINATION_URL: url.href,
              COORDINATION_ENROLLMENT_TOKEN_FILE: tokenFile,
            },
            stderr: "pipe",
          }),
        );
        clients.push(client);
        const call = async (name, args = {}) => {
          const r = await client.callTool({ name, arguments: args });
          assert.notEqual(r.isError, true, JSON.stringify(r.content));
          return r.structuredContent.result;
        };
        assert.ok(
          (await client.listTools()).tools.some(
            (t) => t.name === "collaboration_list",
          ),
        );
        const first = await call("workspace_status");
        assert.equal(first.workspaces.length, 1);
        assert.ok(!JSON.stringify(first).includes(installation.token));
        assert.equal(
          (await call("identity_get")).agent_id,
          first.workspaces[0].agent_id,
        );
        roots = [...roots, { uri: pathToFileURL(repos[1]).href }];
        await client.sendRootsListChanged();
        const second = await call("workspace_status");
        assert.equal(second.workspaces.length, 2);
        assert.equal(second.active_repo_id, null);
        const ambiguous = await client.callTool({
          name: "identity_get",
          arguments: {},
        });
        assert.equal(ambiguous.isError, true);
        await call("workspace_select", {
          repo_id: first.workspaces[0].repo_id,
        });
        assert.equal(
          (await call("identity_get")).agent_id,
          first.workspaces[0].agent_id,
        );
        const task = await call("task_create", {
          input: {
            repo_id: registered.b.repo_id,
            title: "Routed to frontend",
            description: "Uses frontend identity",
          },
        });
        assert.equal(
          task.assignee,
          second.workspaces.find((s) => s.repo_id === registered.b.repo_id)
            .agent_id,
        );
        roots = [{ uri: pathToFileURL(repos[1]).href }];
        await client.sendRootsListChanged();
        const removed = await call("workspace_status");
        assert.equal(removed.workspaces.length, 1);
        assert.equal(removed.active_repo_id, registered.b.repo_id);
      },
    );
    await t.test(
      "clients without roots can register explicitly without repo-local configuration",
      async () => {
        const client = new Client({ name: "manual-fixture", version: "1" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL("../src/bridge.js", import.meta.url))],
            cwd: root,
            env: {
              ...process.env,
              COORDINATION_URL: url.href,
              COORDINATION_ENROLLMENT_TOKEN_FILE: tokenFile,
            },
            stderr: "pipe",
          }),
        );
        clients.push(client);
        assert.equal((await client.listTools()).tools.length, 3);
        const registered = await client.callTool({
          name: "workspace_register",
          arguments: { path: repos[0] },
        });
        assert.notEqual(registered.isError, true);
        assert.ok(!JSON.stringify(registered).includes('"token"'));
        assert.ok(
          (await client.listTools()).tools.some(
            (t) => t.name === "task_create",
          ),
        );
      },
    );
    await t.test(
      "directory pages stay bounded with long client names and many repositories",
      async () => {
        const created = [];
        try {
          for (let i = 0; i < 16; i++) {
            const reference = `fixture:bounded-${i}-` + "r".repeat(450);
            for (let j = 0; j < 3; j++)
              created.push(
                await service.registerWorkspace(enrollment, {
                  name: "n".repeat(450),
                  reference,
                  client: `${i}-${j}-` + "c".repeat(450),
                }),
              );
          }
          const seen = new Set();
          let after;
          do {
            const page = await service.collaboration(registered.pa, { after });
            assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
            assert.ok(page.items.length);
            for (const item of page.items) {
              assert.ok(!seen.has(item.repo_id));
              seen.add(item.repo_id);
            }
            if (!page.has_more) break;
            after = page.next_cursor;
          } while (true);
          assert.equal(seen.size, 18);
        } finally {
          const ids = created.map((r) => r.agent_id);
          const repos = [...new Set(created.map((r) => r.repo_id))];
          await pool.query(
            "DELETE FROM agent_tokens WHERE agent_id=ANY($1::uuid[])",
            [ids],
          );
          await pool.query(
            "DELETE FROM agent_repo_grants WHERE agent_id=ANY($1::uuid[])",
            [ids],
          );
          await pool.query("DELETE FROM agents WHERE id=ANY($1::uuid[])", [
            ids,
          ]);
          await pool.query(
            "DELETE FROM repositories WHERE id=ANY($1::uuid[])",
            [repos],
          );
        }
      },
    );
    await t.test(
      "revoking installation credentials invalidates child workers and hides their presence",
      async () => {
        await service.execute(owner, "token_revoke", {
          id: installation.token_id,
        });
        await assert.rejects(
          service.authenticate(registered.a.token),
          /Installation expired or revoked/,
        );
        await assert.rejects(
          service.identity(registered.pa),
          /Installation expired or revoked/,
        );
        const ordinary = await service.execute(owner, "agent_enroll", {
          name: "Observer",
          grants: [
            { repo_id: registered.a.repo_id, permissions: ["task:read"] },
          ],
        });
        const directory = await service.collaboration(
          await service.authenticate(ordinary.token),
        );
        assert.ok(
          !directory.items
            .flatMap((r) => r.agents)
            .some((a) => a.id === registered.a.agent_id),
        );
      },
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await server.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
