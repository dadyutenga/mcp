import Fastify from "fastify";
import { VERSION } from "./version.js";
import { hash as passwordHash, verify } from "@node-rs/argon2";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { database, transaction, SCHEMA_VERSION } from "./db.js";
import { Service, Fault, hash, token } from "./service.js";
import { mcp } from "./mcp.js";
import { Operations } from "./operations.js";
import { DockerRuntime, loadRuntimeConfig } from "./runtime.js";
export async function app({
  pool,
  bootstrapSecret,
  secureCookies = false,
  importRoot,
  backupRoot,
  runtimeConfig,
} = {}) {
  if (
    !bootstrapSecret ||
    bootstrapSecret.length < 24 ||
    /placeholder|changeme|example|replace_with/i.test(bootstrapSecret)
  )
    throw Error("Set a random BOOTSTRAP_SECRET of at least 24 characters");
  const server = Fastify({
    genReqId: () => randomUUID(),
    logger: false,
    bodyLimit: 32768,
    requestTimeout: 30000,
  });
  const service = new Service(pool);
  const runtime = new DockerRuntime(
    pool,
    service,
    runtimeConfig === undefined ? await loadRuntimeConfig() : runtimeConfig,
  );
  service.runtime = runtime;
  server.decorate("runtime", runtime);
  let runtimeTimer,
    reconciling = false;
  if (runtime.config) {
    const reconcile = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        await runtime.reconcile();
      } catch {
        // Temporary database/daemon failure must not crash the service.
      } finally {
        reconciling = false;
      }
    };
    server.addHook("onReady", async () => {
      await reconcile();
      runtimeTimer = setInterval(reconcile, 2000);
      runtimeTimer.unref();
    });
    server.addHook("onClose", async () => clearInterval(runtimeTimer));
  }
  const rates = new Map();
  const dummyPassword = await passwordHash(token(), {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  server.decorate("service", service);
  const operations = new Operations(pool, service, { importRoot, backupRoot });
  server.setErrorHandler((e, req, reply) => {
    const status =
      e.statusCode ||
      (e.name === "ZodError" ||
      ["ENOENT", "SQLITE_NOTADB", "SQLITE_CANTOPEN"].includes(e.code)
        ? 400
        : 500);
    reply.code(status).send({
      error: {
        message: status === 500 ? "Internal service error" : e.message,
        request_id: req.id,
      },
    });
  });
  server.addHook("onSend", async (req, reply) => {
    reply
      .header("X-Request-Id", req.id)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
  });
  const knownMcpCredentials = new Set();
  function rate(req, credential = "") {
    const route = req.routeOptions?.url || req.url.split("?", 1)[0];
    const key = req.ip + ":" + req.method + ":" + route + ":" + credential;
    const max = route === "/mcp" ? 300 : 20;
    const now = Date.now();
    let r = rates.get(key);
    if (!r || r.until < now) {
      r = { count: 0, until: now + 60000 };
      rates.set(key, r);
    }
    if (++r.count > max) throw new Fault(429, "Try again in one minute");
    if (rates.size > 10000) rates.clear();
  }
  async function mcpPrincipal(req) {
    const raw = req.headers.authorization?.replace(/^Bearer /, "");
    const fingerprint = raw ? hash(raw) : "";
    const known = knownMcpCredentials.has(fingerprint);
    rate(req, known ? fingerprint : "");
    try {
      // Always reauthenticate: a cached bucket never bypasses revocation/expiry.
      const principal = await service.authenticate(raw, req.id);
      if (!known) {
        rate(req, fingerprint);
        if (knownMcpCredentials.size >= 10000) knownMcpCredentials.clear();
        knownMcpCredentials.add(fingerprint);
      }
      return principal;
    } catch (error) {
      knownMcpCredentials.delete(fingerprint);
      throw error;
    }
  }
  async function owner(req, write = false) {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("coord_session="))
      ?.slice(14);
    if (!raw) throw new Fault(401, "Sign in required");
    const s = (
      await pool.query(
        "SELECT * FROM sessions WHERE hash=$1 AND expires_at>now() AND user_id IN (SELECT id FROM users WHERE status='active')",
        [hash(raw)],
      )
    ).rows[0];
    if (!s) throw new Fault(401, "Session expired");
    if (write && req.headers["x-csrf-token"] !== s.csrf)
      throw new Fault(403, "Invalid CSRF token");
    await pool.query("UPDATE sessions SET last_used_at=now() WHERE hash=$1", [
      s.hash,
    ]);
    return {
      id: s.user_id,
      owner: true,
      csrf: s.csrf,
      session_hash: s.hash,
      request_id: req.id,
    };
  }
  server.get("/api/v1/health/live", async () => ({ live: true }));
  server.get("/api/v1/health/ready", async () => {
    const version = Number(
      (await pool.query("SELECT max(version) AS v FROM schema_migrations"))
        .rows[0].v,
    );
    if (version !== SCHEMA_VERSION)
      throw new Fault(503, "Database migration mismatch");
    return { ready: true, schema_version: version };
  });
  server.get("/api/v1/auth/setup", async () => ({
    bootstrap_required: !(await pool.query("SELECT 1 FROM users LIMIT 1"))
      .rowCount,
  }));
  server.post("/api/v1/auth/bootstrap", async (req, reply) => {
    rate(req);
    const { secret, username, password } = req.body || {};
    if (
      typeof secret !== "string" ||
      !timingSafeEqual(
        Buffer.from(hash(secret)),
        Buffer.from(hash(bootstrapSecret)),
      )
    )
      throw new Fault(403, "Invalid bootstrap secret");
    if (
      typeof username !== "string" ||
      username.length < 3 ||
      username.length > 128 ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 256
    )
      throw new Fault(
        400,
        "Use username 3–128 characters and password 12–256 characters",
      );
    const encoded = await passwordHash(password, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await transaction(pool, async (c) => {
      if ((await c.query("SELECT 1 FROM users")).rowCount)
        throw new Fault(409, "Already bootstrapped");
      const id = randomUUID();
      await c.query(
        "INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)",
        [id, username, encoded],
      );
      await service.audit(c, { id, request_id: req.id }, "owner_bootstrap", id);
    });
    reply.code(201);
    return { created: true };
  });
  server.post("/api/v1/auth/session", async (req, reply) => {
    rate(req);
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      password.length > 256
    )
      throw new Fault(400, "Username and password required");
    const u = (
      await pool.query("SELECT * FROM users WHERE username=$1", [username])
    ).rows[0];
    const valid = await verify(u?.password_hash || dummyPassword, password);
    if (!u || u.status !== "active" || !valid) {
      await transaction(pool, (c) =>
        service.audit(
          c,
          { id: "anonymous", request_id: req.id },
          "login_denied",
          null,
          null,
          { outcome: "denied" },
        ),
      );
      throw new Fault(401, "Invalid credentials");
    }
    const raw = token(),
      csrf = token();
    await transaction(pool, async (c) => {
      await c.query(
        "INSERT INTO sessions(hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
        [hash(raw), u.id, csrf],
      );
      await service.audit(
        c,
        { id: u.id, request_id: req.id },
        "owner_login",
        u.id,
      );
    });
    reply.header(
      "Set-Cookie",
      `coord_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? "; Secure" : ""}`,
    );
    return { csrf };
  });
  server.get("/api/v1/auth/me", async (req) => {
    const p = await owner(req);
    return { id: p.id, csrf: p.csrf };
  });
  server.delete("/api/v1/auth/session", async (req, reply) => {
    const p = await owner(req, true);
    await transaction(pool, async (c) => {
      await c.query("DELETE FROM sessions WHERE hash=$1", [p.session_hash]);
      await service.audit(c, p, "owner_logout", p.id);
    });
    reply.header(
      "Set-Cookie",
      "coord_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { logged_out: true };
  });
  server.get("/api/v1/auth/sessions", async (req) => {
    const p = await owner(req);
    return (
      await pool.query(
        "SELECT id,created_at,last_used_at,expires_at,hash=$2 AS current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at",
        [p.id, p.session_hash],
      )
    ).rows;
  });
  server.delete("/api/v1/auth/sessions/:id", async (req) => {
    const p = await owner(req, true);
    const r = await transaction(pool, async (c) => {
      const result = await c.query(
        "DELETE FROM sessions WHERE user_id=$1 AND id=$2 RETURNING id",
        [p.id, req.params.id],
      );
      if (!result.rowCount) throw new Fault(404, "Unknown session");
      await service.audit(c, p, "session_revoke", req.params.id);
      return { revoked: true };
    });
    return r;
  });
  server.get("/api/v1/metrics", async (req, reply) => {
    await owner(req);
    await pool.query("SELECT 1");
    const count = Number(
      (await pool.query("SELECT count(*) FROM tasks")).rows[0].count,
    );
    reply.type("text/plain");
    return (
      "coordination_database_ready 1\ncoordination_tasks_total " + count + "\n"
    );
  });
  server.get("/api/v1/resources/:kind", async (req) =>
    service.read(await owner(req), req.params.kind, req.query),
  );
  server.get("/api/v1/resources/:kind/:id", async (req) =>
    service.resource(await owner(req), req.params.kind, req.params.id),
  );
  server.post("/api/v1/actions/:action", async (req) =>
    service.execute(
      await owner(req, true),
      req.params.action,
      req.body,
      req.headers["idempotency-key"],
    ),
  );
  server.get("/api/v1/notifications", async (req) =>
    service.notifications(await owner(req), Number(req.query.after || 0), {
      before: req.query.before,
      latest: req.query.latest === "true",
    }),
  );
  server.post("/api/v1/notifications/:id/read", async (req) =>
    service.markRead(await owner(req, true), Number(req.params.id)),
  );
  server.get("/api/v1/audit", async (req) =>
    service.events(await owner(req), Number(req.query.after) || 0),
  );
  server.get("/api/v1/operations", async (req) =>
    operations.status(await owner(req)),
  );
  server.get("/api/v1/imports/discover", async (req) =>
    operations.discover(await owner(req)),
  );
  server.post("/api/v1/imports/inspect", async (req) =>
    operations.inspect(await owner(req, true), req.body),
  );
  server.post("/api/v1/imports/:id/review", async (req) =>
    operations.review(await owner(req, true), req.params.id, req.body),
  );
  server.post("/api/v1/imports/:id/apply", async (req) =>
    operations.apply(await owner(req, true), req.params.id, req.body),
  );
  server.get("/api/v1/settings", async (req) => {
    await owner(req);
    return {
      runtime: await runtime.health(),
      advisory_leases: true,
      outbox_pending: Number(
        (
          await pool.query(
            "SELECT count(*) FROM outbox_events WHERE delivered_at IS NULL",
          )
        ).rows[0].count,
      ),
      database: "postgresql",
      public_remote: false,
    };
  });
  server.post("/api/v1/runtime/start", async (req) =>
    runtime.start(await owner(req, true), req.body),
  );
  server.get("/api/v1/runtime/:id", async (req) =>
    runtime.status(await owner(req), req.params.id),
  );
  server.get("/api/v1/runtime/:id/diff", async (req) =>
    runtime.diff(await owner(req), req.params.id),
  );
  server.get("/api/v1/runtime/:id/output", async (req) =>
    runtime.output(await owner(req), req.params.id),
  );
  server.post("/api/v1/runtime/:id/:control", async (req) => {
    const p = await owner(req, true);
    if (req.params.control === "collect")
      return runtime.collect(p, req.params.id);
    if (req.params.control === "write")
      return runtime.apply(p, req.params.id, req.body?.files);
    return runtime.control(p, req.params.id, req.params.control);
  });
  server.get("/api/v1/events", async (req, reply) => {
    const p = await owner(req);
    let cursor = Number(req.headers["last-event-id"] || req.query.after) || 0;
    await service.events(p, cursor);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await owner(req);
        for (const e of await service.events(p, cursor)) {
          reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = Number(e.id);
          await pool.query(
            "UPDATE outbox_events SET delivered_at=now() WHERE id=$1 AND delivered_at IS NULL",
            [e.id],
          );
        }
        reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.end();
      } finally {
        busy = false;
      }
    };
    let timer;
    reply.raw.on("close", () => clearInterval(timer));
    await tick();
    if (!reply.raw.destroyed) timer = setInterval(tick, 1500);
  });
  server.get("/mcp", async (req, reply) => {
    await mcpPrincipal(req);
    reply.code(405);
    return {
      error: { message: "Use authenticated POST requests for stateless MCP" },
    };
  });
  server.delete("/mcp", async (req, reply) => {
    await mcpPrincipal(req);
    reply.code(405);
    return {
      error: { message: "Stateless MCP has no server session to delete" },
    };
  });
  server.post("/mcp", async (req, reply) => {
    const p = await mcpPrincipal(req);
    p.request_id = req.id;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const instance = mcp(service, p);
    await instance.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      transport.close();
      instance.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  server.get("/", async () => ({
    service: "agent-coordination",
    version: VERSION,
    transport: "streamable-http",
    mcp_endpoint: "/mcp",
    setup:
      "npm run setup:operator --prefix product -- --config /absolute/private/operator.json",
    frontend: false,
  }));
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const pool = await database(process.env.DATABASE_URL);
  const server = await app({
    pool,
    bootstrapSecret: process.env.BOOTSTRAP_SECRET,
    secureCookies: process.env.SECURE_COOKIES === "true",
  });
  const host = process.env.HOST || "127.0.0.1";
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    process.env.ALLOW_CONTAINER_BIND !== "true"
  )
    throw Error(
      "Non-loopback binding requires explicit configuration and a TLS boundary",
    );
  await server.listen({ host, port: Number(process.env.PORT || 4310) });
  console.log(
    "Coordination API listening on port " + (process.env.PORT || 4310),
  );
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, async () => {
      await server.close();
      await pool.end();
      process.exit(0);
    });
}
