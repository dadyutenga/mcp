import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { app } from "../src/server.js";
import { permissions, normalizePath } from "../src/service.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "TEST_DATABASE_URL must identify a disposable PostgreSQL database",
  );
test("real PostgreSQL / owner HTTP / two scoped MCP agents / restart / authorization and races", async () => {
  const pool = await database(url);
  await pool.query(
    "TRUNCATE users,sessions,projects,repositories,agents,agent_tokens,agent_repo_grants,tasks,task_dependencies,task_events,file_reservations,shared_context_items,cross_repo_requests,cross_repo_responses,audit_events,outbox_events,idempotency,imports CASCADE",
  );
  let server = await app({
    pool,
    bootstrapSecret: "test-bootstrap-secret-is-at-least-32-chars",
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = () => `http://127.0.0.1:${server.server.address().port}`;
  let cookie = "",
    csrf = "";
  async function http(
    path,
    body,
    method = body ? "POST" : "GET",
    headers = {},
  ) {
    const r = await server.inject({
      method,
      url: "/api/v1/" + path,
      headers: { cookie, "x-csrf-token": csrf, ...headers },
      payload: body,
    });
    const data = r.json();
    return { status: r.statusCode, data, headers: r.headers };
  }
  const clients = [];
  try {
    assert.equal(
      (await http("actions/project_create", { name: "Forbidden" })).status,
      401,
    );
    assert.equal(
      (
        await http("auth/bootstrap", {
          secret: "wrong",
          username: "owner",
          password: "strong-password-test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http("auth/bootstrap", {
          secret: "test-bootstrap-secret-is-at-least-32-chars",
          username: "owner",
          password: "strong-password-test",
        })
      ).status,
      201,
    );
    const login = await http("auth/session", {
      username: "owner",
      password: "strong-password-test",
    });
    cookie = login.headers["set-cookie"].split(";")[0];
    csrf = login.data.csrf;
    assert.equal(login.status, 200);
    assert.match(login.headers["set-cookie"], /HttpOnly/);
    assert.match(login.headers["set-cookie"], /SameSite=Strict/);
    const storedPassword = (
      await pool.query("SELECT password_hash FROM users WHERE username=$1", [
        "owner",
      ])
    ).rows[0].password_hash;
    assert.match(storedPassword, /^\$argon2id\$/);
    assert.ok(!storedPassword.includes("strong-password-test"));
    assert.equal(
      (
        await http("actions/project_create", { name: "Forbidden" }, "POST", {
          "x-csrf-token": "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (await server.inject({ method: "GET", url: "/mcp" })).statusCode,
      401,
    );
    assert.equal(
      (
        await http("auth/session", {
          username: "owner",
          password: "wrong-password",
        })
      ).status,
      401,
    );
    const secondLogin = await http("auth/session", {
      username: "owner",
      password: "strong-password-test",
    });
    const secondCookie = secondLogin.headers["set-cookie"].split(";")[0];
    const sessions = (await http("auth/sessions")).data;
    assert.equal(sessions.length, 2);
    const secondSession = sessions.find((s) => !s.current);
    assert.ok(!JSON.stringify(sessions).includes("hash"));
    assert.equal(
      (await http("auth/sessions/" + secondSession.id, undefined, "DELETE"))
        .status,
      200,
    );
    assert.equal(
      (await http("auth/me", undefined, "GET", { cookie: secondCookie }))
        .status,
      401,
    );
    const owner = { id: (await http("auth/me")).data.id, owner: true };
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [
      owner.id,
    ]);
    try {
      assert.equal((await http("auth/me")).status, 401);
    } finally {
      await pool.query("UPDATE users SET status='active' WHERE id=$1", [
        owner.id,
      ]);
    }
    const exec = async (a, x) => {
      const r = await http("actions/" + a, x);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data;
    };
    const project = await exec("project_create", { name: "Ride hailing" });
    assert.equal((await http("audit?after=999999999")).status, 409);
    const retryHeaders = { "idempotency-key": "project-retry-1" };
    const retry1 = await http(
      "actions/project_create",
      { name: "Retry test", description: "Same request" },
      "POST",
      retryHeaders,
    );
    const retry2 = await http(
      "actions/project_create",
      { description: "Same request", name: "Retry test" },
      "POST",
      retryHeaders,
    );
    assert.equal(retry1.data.id, retry2.data.id);
    assert.equal(
      (
        await http(
          "actions/project_create",
          { name: "Different request" },
          "POST",
          retryHeaders,
        )
      ).status,
      409,
    );
    const notes = await http("notifications");
    const note = notes.data[0];
    assert.equal(note.read_at, null);
    assert.equal(
      (await http("notifications/" + note.id + "/read", {})).status,
      200,
    );
    assert.equal(
      (await http("notifications/" + note.id + "/read", {})).status,
      200,
    );
    assert.ok(
      (await http("notifications")).data.find((n) => n.id === note.id).read_at,
    );
    assert.equal(
      (
        await http("notifications/" + note.id + "/read", {}, "POST", {
          "x-csrf-token": "wrong",
        })
      ).status,
      403,
    );
    const controller = new AbortController();
    const stream = await fetch(base() + "/api/v1/events", {
      headers: { cookie },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const frame = new TextDecoder().decode(
      (await stream.body.getReader().read()).value,
    );
    const firstId = Number(frame.match(/id: (\d+)/)[1]);
    controller.abort();
    const reconnectController = new AbortController();
    const reconnect = await fetch(base() + "/api/v1/events", {
      headers: { cookie, "last-event-id": String(firstId) },
      signal: reconnectController.signal,
    });
    const resumed = new TextDecoder().decode(
      (await reconnect.body.getReader().read()).value,
    );
    assert.ok(Number(resumed.match(/id: (\d+)/)[1]) > firstId);
    reconnectController.abort();
    const a = await exec("repo_create", {
        project_id: project.id,
        name: "Mobile",
        reference: "/sample/mobile",
      }),
      b = await exec("repo_create", {
        project_id: project.id,
        name: "Go backend",
        reference: "/sample/backend",
      });
    const enroll = async (repo, name) =>
      exec("agent_enroll", {
        name,
        grants: [{ repo_id: repo.id, permissions }],
      });
    const aa = await enroll(a, "Mobile agent"),
      bb = await enroll(b, "Backend agent"),
      racer = await enroll(a, "Second mobile agent");
    assert.equal(
      (
        await pool.query(
          "SELECT body->>'hash' AS hash FROM agent_tokens WHERE id=$1",
          [aa.token_id],
        )
      ).rows[0].hash.includes(aa.token),
      false,
    );
    const pa = await server.service.authenticate(aa.token),
      pb = await server.service.authenticate(bb.token),
      pc = await server.service.authenticate(racer.token);
    const ca = new Client({ name: "mobile", version: "1" }),
      cb = new Client({ name: "backend", version: "1" });
    clients.push(ca, cb);
    await ca.connect(
      new StreamableHTTPClientTransport(new URL(base() + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + aa.token } },
      }),
    );
    await cb.connect(
      new StreamableHTTPClientTransport(new URL(base() + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + bb.token } },
      }),
    );
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const bridge = new Client({ name: "bridge-test", version: "1" });
    clients.push(bridge);
    await bridge.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../src/bridge.js", import.meta.url).pathname],
        env: {
          ...process.env,
          COORDINATION_URL: base() + "/mcp",
          COORDINATION_AGENT_TOKEN: aa.token,
        },
        stderr: "inherit",
      }),
    );
    assert.ok(
      (await bridge.listTools()).tools.find((t) => t.name === "task_claim")
        .inputSchema.properties.input,
    );
    const call = async (c, name, args = {}) => {
      const r = await c.callTool({ name, arguments: args });
      assert.notEqual(r.isError, true, JSON.stringify(r));
      return r.structuredContent.result;
    };
    assert.equal((await call(bridge, "identity_get")).agent_id, aa.agent.id);
    assert.equal((await call(ca, "identity_get")).agent_id, aa.agent.id);
    assert.equal((await call(ca, "repositories_list")).items.length, 1);
    const task = await exec("task_create", {
      repo_id: a.id,
      title: "Login screen",
      description: "Use backend contract",
      assignee: aa.agent.id,
    });
    const claimed = await call(ca, "task_claim", { input: { id: task.id } });
    assert.equal(claimed.state, "in_progress");
    const update = await call(ca, "task_update", {
      input: {
        id: task.id,
        version: claimed.version,
        progress: 40,
        comment: "Connecting contract",
      },
    });
    assert.equal(update.progress, 40);
    await assert.rejects(
      server.service.execute(pa, "task_update", {
        id: task.id,
        version: 1,
        progress: 2,
      }),
      /Stale/,
    );
    const request = await call(ca, "request_create", {
      input: {
        repo_id: a.id,
        target_repo: b.id,
        reason: "Implement sign in",
        scope: "POST /login request and response fields",
        type: "api-contract",
      },
    });
    assert.equal(
      (
        await ca.callTool({
          name: "request_decide",
          arguments: {
            input: {
              id: request.id,
              decision: "approved",
              reason: "Self approval",
            },
          },
        })
      ).isError,
      true,
    );
    await call(cb, "request_decide", {
      input: {
        id: request.id,
        decision: "approved",
        reason: "Exact contract only",
      },
    });
    await call(cb, "request_answer", {
      input: {
        id: request.id,
        content:
          '{"method":"POST","path":"/login","request":{"email":"string"},"response":{"session":"redacted example"}}',
      },
    });
    assert.equal((await call(ca, "cross_repo_responses_list")).items.length, 1);
    assert.equal(
      (
        await ca.callTool({
          name: "task_update",
          arguments: {
            input: {
              id: task.id,
              version: update.version,
              agent_id: bb.agent.id,
              progress: 90,
            },
          },
        })
      ).isError,
      true,
    );
    const privateContext = await server.service.execute(pb, "context_publish", {
      repo_id: b.id,
      key: "private-api",
      content: "Private backend details",
      permitted_repos: [b.id],
    });
    assert.equal((await call(ca, "shared_context_items_list")).items.length, 0);
    await assert.rejects(
      pool.query(
        "UPDATE shared_context_items SET body=jsonb_set(body,'{content}','\"tampered\"') WHERE id=$1",
        [privateContext.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      server.service.execute(pa, "context_publish", {
        repo_id: b.id,
        key: "forged",
        content: "Forged",
        permitted_repos: [],
      }),
      /Permission/,
    );
    await assert.rejects(
      server.service.execute(pa, "context_publish", {
        repo_id: a.id,
        key: "bad",
        content: "API_KEY=supersecrettoken",
        permitted_repos: [a.id],
      }),
      /secret/,
    );
    const race = await exec("task_create", {
      repo_id: a.id,
      title: "Claim race",
      description: "Exactly one winner",
    });
    const outcomes = await Promise.allSettled([
      server.service.execute(pa, "task_claim", { id: race.id }),
      server.service.execute(pc, "task_claim", { id: race.id }),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    const task2 = await exec("task_create", {
      repo_id: a.id,
      title: "Other file editor",
      description: "Race on path",
    });
    await server.service.execute(pc, "task_claim", { id: task2.id });
    const leases = await Promise.allSettled([
      server.service.execute(pa, "reservation_acquire", {
        repo_id: a.id,
        task_id: task.id,
        path: "src/Login.tsx",
      }),
      server.service.execute(pc, "reservation_acquire", {
        repo_id: a.id,
        task_id: task2.id,
        path: "src/Login.tsx",
      }),
    ]);
    assert.equal(leases.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(normalizePath("Src/API.ts", true), "Src/API.ts");
    assert.equal(normalizePath("Src/API.ts", false), "src/api.ts");
    for (const p of ["../bad", "/absolute", "src/../bad", "bad\u0000path"])
      assert.throws(() => normalizePath(p));
    const review = await server.service.execute(pa, "task_update", {
      id: task.id,
      version: update.version,
      state: "review",
    });
    await server.service.execute(pa, "task_update", {
      id: task.id,
      version: review.version,
      state: "done",
    });
    assert.equal(
      (await server.service.read(owner, "file_reservations")).items.filter(
        (l) => l.task_id === task.id && l.state === "active",
      ).length,
      0,
    );
    await pool.query(
      "UPDATE agent_tokens SET body=jsonb_set(body,'{expires_at}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
      [racer.token_id],
    );
    await assert.rejects(server.service.authenticate(racer.token), /Expired/);
    await assert.rejects(
      pool.query(
        "UPDATE audit_events SET action='tampered' WHERE id=(SELECT min(id) FROM audit_events)",
      ),
      /append-only/,
    );
    await exec("token_revoke", { id: aa.token_id });
    await assert.rejects(server.service.authenticate(aa.token), /revoked/);
    await assert.rejects(
      pool.query(
        "UPDATE tasks SET body=jsonb_set(body,'{state}','\"invalid-state\"') WHERE id=$1",
        [task.id],
      ),
      /task_state/,
    );
    const cachedInput = {
      repo_id: b.id,
      key: "cache-auth-scope",
      content: "Reviewed contract",
      permitted_repos: [b.id],
    };
    await server.service.execute(
      pb,
      "context_publish",
      cachedInput,
      "scope-retry",
    );
    await exec("grant_set", {
      agent_id: bb.agent.id,
      repo_id: b.id,
      permissions: [],
      reason: "Revoke scope for test",
    });
    await assert.rejects(
      server.service.execute(pb, "context_publish", cachedInput, "scope-retry"),
      /Authorization changed/,
    );
    const audit = await http("audit");
    assert.ok(audit.data.some((e) => e.action === "agent_auth_denied"));
    assert.ok(audit.data.some((e) => e.action === "agent_authenticated"));
    assert.ok(audit.data.some((e) => e.action === "authorization_denied"));
    assert.ok(audit.data.some((e) => e.action === "request_answer"));
    assert.ok(!JSON.stringify(audit.data).includes(aa.token));
    await Promise.all(clients.map((c) => c.close()));
    clients.length = 0;
    await server.close();
    server = await app({
      pool,
      bootstrapSecret: "test-bootstrap-secret-is-at-least-32-chars",
    });
    assert.equal((await http("auth/me")).status, 200);
    assert.equal((await http("resources/tasks")).data.items.length, 3);
    assert.equal(
      (await http("resources/cross_repo_responses")).data.items.length,
      1,
    );
    assert.equal((await http("settings")).data.runtime.available, false);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    await pool.end();
  }
});

test("SQLite backup, inspection, safe import, untrusted identities, historical leases and idempotence", async () => {
  const { inspectImport, applyImport } = await import("../src/import.js");
  const { Service } = await import("../src/service.js");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { default: Sqlite } = await import("better-sqlite3");
  const root = mkdtempSync(path.join(os.tmpdir(), "product-import-"));
  const source = path.join(root, "legacy.sqlite");
  const old = new Sqlite(source);
  const taskId = randomUUID();
  old.exec(
    "CREATE TABLE agents(id TEXT,display_name TEXT);CREATE TABLE tasks(id TEXT,title TEXT,description TEXT,status TEXT,progress INTEGER,priority INTEGER);CREATE TABLE file_reservations(id TEXT,repository_path TEXT,normalized_path TEXT,task_id TEXT,expires_at TEXT);CREATE TABLE messages(id TEXT,body TEXT);PRAGMA user_version=2",
  );
  old.prepare("INSERT INTO agents VALUES(?,?)").run("old-agent", "Old agent");
  old
    .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
    .run(taskId, "Imported task", "Keep history", "in_progress", 20, 3);
  old
    .prepare("INSERT INTO file_reservations VALUES(?,?,?,?,?)")
    .run(randomUUID(), "src/a.js", "src/a.js", taskId, "2099-01-01T00:00:00Z");
  const messageId = randomUUID();
  old
    .prepare("INSERT INTO messages VALUES(?,?)")
    .run(messageId, "Historical coordination note");
  old.close();
  const before = readFileSync(source);
  const pool = await database(url);
  const service = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  try {
    const project = await service.execute(owner, "project_create", {
      name: "Import test",
    });
    const repo = await service.execute(owner, "repo_create", {
      project_id: project.id,
      name: "Legacy",
      reference: "local:fixture",
    });
    const plan = await inspectImport(
      source,
      path.join(root, "backups"),
      "fixture-source",
    );
    assert.equal(plan.counts.tasks, 1);
    assert.deepEqual(readFileSync(source), before);
    const result = await applyImport(pool, plan, repo.id);
    assert.equal(result.mapped, 4);
    assert.equal(
      (await service.resource(owner, "messages", messageId)).legacy_record.body,
      "Historical coordination note",
    );
    assert.equal(
      (await applyImport(pool, plan, repo.id)).already_imported,
      true,
    );
    const tasks = await service.read(owner, "tasks");
    assert.equal(tasks.items.find((t) => t.id === taskId).state, "blocked");
    const agents = await service.read(owner, "agents");
    assert.equal(
      agents.items.find((a) => a.legacy_id === "old-agent").revoked,
      true,
    );
    assert.equal(
      (await service.read(owner, "file_reservations")).items.find(
        (l) => l.task_id === taskId,
      ).state,
      "expired",
    );
    assert.deepEqual(readFileSync(source), before);
  } finally {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser sign-in, project creation, real resource rendering and responsive navigation", async () => {
  const { chromium } = await import("@playwright/test");
  const pool = await database(url);
  const server = await app({
    pool,
    bootstrapSecret: "test-bootstrap-secret-is-at-least-32-chars",
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);
    await page.getByLabel("Username").fill("owner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("strong-password-test");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Keep work moving." }).waitFor();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "+ Create", exact: true }).click();
    await page
      .getByLabel("name", { exact: true })
      .fill("Browser verified project");
    await page
      .getByLabel("description", { exact: true })
      .fill("Created through the actual operator panel");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("heading", { name: "Browser verified project", exact: true })
      .waitFor();
    // An interrupted background refresh must recover without leaving a stale alert.
    const unavailable = "**/api/v1/resources/projects?*";
    await page.route(unavailable, (route) => route.abort("failed"));
    await page.reload();
    await page
      .getByRole("alert")
      .filter({ hasText: "Failed to fetch" })
      .waitFor();
    await page.unroute(unavailable);
    await page.waitForFunction(
      () => !document.querySelector('[role="alert"]'),
      null,
      {
        timeout: 25000,
      },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "/tmp/coordination-product-mobile.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
    await server.close();
    await pool.end();
  }
});
