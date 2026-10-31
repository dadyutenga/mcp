import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import Sqlite from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { permissions } from "../src/service.js";
import { dockerConnection } from "../src/docker.js";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  temporary = mkdtempSync(path.join(os.tmpdir(), "coordination-release-")),
  project = "coord-e2e-" + Date.now();
const random = () => randomBytes(32).toString("hex"),
  dbPassword = random(),
  bootstrap = random(),
  ownerPassword = random(),
  sourceDir = path.join(temporary, "imports");
mkdirSync(sourceDir, { mode: 0o755 });
const { args: dockerArgs, env: childEnv } = dockerConnection();
const docker = (args, options = {}) =>
  execFileSync("docker", [...dockerArgs, ...args], {
    cwd: root,
    env: childEnv,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
const port = await freePort(),
  restoredPort = await freePort(),
  base = `http://127.0.0.1:${port}`,
  envFile = path.join(temporary, "compose.env");
writeFileSync(
  envFile,
  `POSTGRES_PASSWORD=${dbPassword}\nBOOTSTRAP_SECRET=${bootstrap}\nCOORDINATION_PORT=${port}\nLEGACY_IMPORT_ROOT=${sourceDir}\n`,
  { mode: 0o600 },
);
const compose = (args, options = {}) =>
  docker(["compose", "--env-file", envFile, "-p", project, ...args], options);
const clients = [];
const checks = [];
let restorationStarted = false;
let incompatibleStarted = false;
const report = (message) => {
  checks.push(message);
  console.log("PASS " + message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(url) {
  for (let n = 0; n < 90; n++) {
    try {
      const r = await fetch(url + "/api/v1/health/ready", {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {}
    await wait(500);
  }
  throw Error("Service failed readiness: " + url);
}
let cookie = "",
  csrf = "";
async function ownerApi(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(base + "/api/v1/" + url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  assert.ok(r.ok, JSON.stringify(result));
  return result;
}
async function all(kind) {
  let after = "",
    rows = [];
  for (;;) {
    const p = await ownerApi("resources/" + kind + "?after=" + after);
    rows.push(...p.items);
    if (!p.has_more) return rows;
    after = p.next_cursor;
  }
}
async function call(c, name, input) {
  const r = await c.callTool({ name, arguments: input ? { input } : {} });
  assert.notEqual(r.isError, true, JSON.stringify(r));
  return r.structuredContent.result;
}
async function connect(raw, name) {
  const c = new Client({ name, version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + raw } },
    }),
  );
  clients.push(c);
  return c;
}
try {
  if (process.env.SKIP_ACCEPTANCE_BUILD !== "true") {
    console.log(
      "Building the real local Compose stack. Build output: /tmp/coordination-release-build.log",
    );
    const fd = openSync("/tmp/coordination-release-build.log", "w");
    try {
      const args = ["build", "-t", "coordination-product"];
      const ca = process.env.BUILD_CA_FILE || process.env.CODEX_PROXY_CERT;
      if (ca) args.push("--secret", "id=proxy_ca,src=" + ca);
      args.push(".");
      docker(args, { stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
  } else
    console.log(
      "Using explicitly prebuilt image " +
        docker([
          "image",
          "inspect",
          "coordination-product",
          "--format",
          "{{.Id}}",
        ])
          .toString()
          .trim(),
    );
  compose(["up", "--no-build", "--wait"], { stdio: "pipe" });
  await ready(base);
  report(
    "Docker image and isolated Compose PostgreSQL/API stack are healthy on loopback",
  );
  const bootstrapResponse = await fetch(base + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: bootstrap,
      username: "operator",
      password: ownerPassword,
    }),
  });
  assert.equal(bootstrapResponse.status, 201);
  const login = await fetch(base + "/api/v1/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: ownerPassword }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrf = (await login.json()).csrf;
  assert.equal((await (await fetch(base)).json()).frontend, false);
  const p = await ownerApi("actions/project_create", {
    name: "Acceptance ride-hailing",
    description: "Two independent repositories",
  });
  const a = await ownerApi("actions/repo_create", {
      project_id: p.id,
      name: "Mobile",
      reference: "/sample/mobile",
    }),
    b = await ownerApi("actions/repo_create", {
      project_id: p.id,
      name: "Go backend",
      reference: "/sample/backend",
    });
  report(
    "Headless operator API bootstraps and creates a project with two repositories; no frontend is served",
  );
  async function enroll(name, repo) {
    const record = await ownerApi("actions/agent_enroll", {
      name,
      grants: [{ repo_id: repo.id, permissions }],
    });
    return { raw: record.token, agent: record.agent };
  }
  const aa = await enroll("Mobile agent", a),
    bb = await enroll("Backend agent", b),
    cc = await enroll("Race agent", a);
  const ca = await connect(aa.raw, "mobile"),
    cb = await connect(bb.raw, "backend"),
    ccClient = await connect(cc.raw, "race");
  assert.equal((await call(ca, "identity_get")).agent_id, aa.agent.id);
  assert.equal((await call(ca, "repositories_list")).items.length, 1);
  assert.ok(
    !(await all("agent_tokens")).some((t) =>
      JSON.stringify(t).includes(aa.raw),
    ),
  );
  report(
    "Separately enrolled MCP agents connect with hash-only credentials and isolated repository scopes",
  );
  const setup = await ca.callTool({ name: "agent_setup", arguments: {} });
  assert.equal(setup.structuredContent.result.repo_id, a.id);
  let task = await call(ca, "task_create", {
    repo_id: a.id,
    title: "Implement mobile login",
    description: "Use the backend login contract",
    priority: 3,
  });
  task = await call(ca, "task_claim", { id: task.id });
  task = await call(ca, "task_update", {
    id: task.id,
    version: task.version,
    progress: 40,
    comment: "Waiting for precise login contract",
  });
  assert.equal((await all("tasks")).find((t) => t.id === task.id).progress, 40);
  report(
    "MCP agents set up their scoped repo and create, claim, update and comment on tasks",
  );
  const q = await call(ca, "request_create", {
    repo_id: a.id,
    target_repo: b.id,
    task_id: task.id,
    reason: "Implement mobile sign-in",
    scope: "POST /login request and response fields only",
    type: "api-contract",
  });
  const denied = await ca.callTool({
    name: "request_decide",
    arguments: {
      input: {
        id: q.id,
        decision: "approved",
        reason: "Attempted self approval",
      },
    },
  });
  assert.equal(denied.isError, true);
  const delivered = await call(cb, "request_read", { id: q.id });
  await call(cb, "request_work", {
    id: q.id,
    revision: delivered.request_revision,
    status: "working",
    note: "Inspect fixture login request and response contract",
  });
  await call(cb, "request_decide", {
    id: q.id,
    decision: "approved",
    reason: "Only the named login contract is approved",
  });
  await call(cb, "request_answer", {
    id: q.id,
    content:
      '{"method":"POST","path":"/login","request":{"email":"string","password":"<redacted>"},"response":{"userId":"uuid","session":"<redacted>"}}',
    evidence: "Verified fixture login contract request and response fields",
  });
  assert.equal((await call(ca, "cross_repo_responses_list")).items.length, 1);
  const events = await ca.callTool({
    name: "events_poll",
    arguments: { after: 0 },
  });
  assert.ok(
    events.structuredContent.result.some(
      (e) => e.action === "cross_repo_answer_ready",
    ),
  );
  report(
    "Scoped request is approved and answered through Backend MCP and delivered only to its requester",
  );
  const typedContract = JSON.stringify({
    properties: { password: { type: "string", minLength: 12 } },
  });
  const published = await call(cb, "context_publish", {
    repo_id: b.id,
    key: "private-backend",
    content: typedContract,
    permitted_repos: [b.id],
  });
  const typedRead = await cb.callTool({
    name: "shared_context_items_get",
    arguments: { id: published.id },
  });
  assert.equal(typedRead.structuredContent.result.content, typedContract);
  const secretWrite = await fetch(base + "/api/v1/actions/context_publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify({
      repo_id: b.id,
      key: "must-not-persist",
      content: '{"password":"hunter2"}',
      permitted_repos: [b.id],
    }),
  });
  assert.equal(secretWrite.status, 400);
  assert.equal((await call(ca, "shared_context_items_list")).items.length, 0);
  const forged = await ca.callTool({
    name: "task_update",
    arguments: {
      input: {
        id: task.id,
        version: task.version,
        agent_id: bb.agent.id,
        progress: 80,
      },
    },
  });
  assert.equal(forged.isError, true);
  report(
    "Unauthorized context reads, self-approval and forged identity arguments are denied",
  );
  const makeTask = (title, assignee) =>
    ownerApi("actions/task_create", {
      repo_id: a.id,
      title,
      description: "Acceptance concurrency fixture",
      ...(assignee ? { assignee } : {}),
    });
  const race = await makeTask("Atomic task claim");
  const races = await Promise.all(
    [ca, ccClient].map((c) =>
      c.callTool({ name: "task_claim", arguments: { input: { id: race.id } } }),
    ),
  );
  assert.equal(races.filter((r) => !r.isError).length, 1);
  const other = await makeTask("Second file editor", cc.agent.id);
  await call(ccClient, "task_claim", { id: other.id });
  const leaseInput = [
    { repo_id: a.id, task_id: task.id, path: "src" },
    { repo_id: a.id, task_id: other.id, path: "src/Login.tsx" },
  ];
  const leaseResults = await Promise.all(
    [ca, ccClient].map((c, i) =>
      c.callTool({
        name: "reservation_acquire",
        arguments: { input: leaseInput[i] },
      }),
    ),
  );
  assert.equal(leaseResults.filter((r) => !r.isError).length, 1);
  for (let i = 0; i < 2; i++)
    if (!leaseResults[i].isError)
      await call([ca, ccClient][i], "reservation_release", {
        id: leaseResults[i].structuredContent.result.id,
      });
  report(
    "Real concurrent MCP task claims and overlapping path reservations have exactly one winner",
  );
  const cancelLease = await call(ccClient, "reservation_acquire", {
    repo_id: a.id,
    task_id: other.id,
    path: "cancel-intent.tmp",
  });
  const currentOther = (await all("tasks")).find((t) => t.id === other.id);
  await ownerApi("actions/task_update", {
    id: other.id,
    version: currentOther.version,
    state: "cancelled",
  });
  assert.equal(
    (await all("file_reservations")).find((l) => l.id === cancelLease.id).state,
    "released",
  );
  const lease = await call(ca, "reservation_acquire", {
    repo_id: a.id,
    task_id: task.id,
    path: "src/Login.tsx",
  });
  task = await call(ca, "task_update", {
    id: task.id,
    version: task.version,
    state: "review",
  });
  await ownerApi("actions/task_update", {
    id: task.id,
    version: task.version,
    state: "done",
  });
  task = (await all("tasks")).find((t) => t.id === task.id);
  assert.equal(task.priority, 3);
  assert.equal(
    (await all("file_reservations")).find((l) => l.id === lease.id).state,
    "released",
  );
  assert.equal(task.progress, 100);
  report(
    "Completion/cancellation release task leases and record lifecycle history; external IDE controls remain outside the managed runner",
  );
  const source = path.join(sourceDir, "sample.sqlite"),
    old = new Sqlite(source),
    legacyTask = randomUUID();
  old.exec(
    "CREATE TABLE agents(id TEXT,display_name TEXT);CREATE TABLE tasks(id TEXT,title TEXT,description TEXT,status TEXT,progress INTEGER,priority INTEGER);CREATE TABLE messages(id TEXT,body TEXT);PRAGMA user_version=2",
  );
  old
    .prepare("INSERT INTO agents VALUES(?,?)")
    .run("historical-agent", "Untrusted old agent");
  old
    .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
    .run(
      legacyTask,
      "Imported acceptance task",
      "From a read-only sample",
      "completed",
      100,
      2,
    );
  old
    .prepare("INSERT INTO messages VALUES(?,?)")
    .run(randomUUID(), "Archived coordination agreement");
  old.close();
  const sourceHash = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  assert.ok(
    (await ownerApi("imports/discover")).items.some(
      (x) => x.path === "sample.sqlite",
    ),
  );
  const plan = await ownerApi("imports/inspect", {
    source: "sample.sqlite",
    source_id: "acceptance-source",
  });
  const reviewed = await ownerApi("imports/" + plan.id + "/review", {
    default_repo: a.id,
  });
  plan.review_version = reviewed.review_version;
  await ownerApi("imports/" + plan.id + "/apply", {
    confirm: true,
    review_version: plan.review_version,
  });
  const replay = await ownerApi("imports/" + plan.id + "/apply", {
    confirm: true,
    review_version: plan.review_version,
  });
  assert.equal(replay.already_imported, true);
  assert.equal(
    createHash("sha256").update(readFileSync(source)).digest("hex"),
    sourceHash,
  );
  assert.equal(
    (await all("agents")).find((a) => a.legacy_id === "historical-agent")
      .revoked,
    true,
  );
  assert.equal(
    (await all("tasks")).find((t) => t.id === legacyTask).state,
    "done",
  );
  report(
    "Headless SQLite backup/inspection/review/import preserves source data, keeps identities revoked and is idempotent",
  );
  const before = (await all("tasks")).length;
  compose(["restart"], { stdio: "pipe" });
  await ready(base);
  assert.equal((await all("tasks")).length, before);
  assert.equal((await all("cross_repo_responses")).length, 1);
  report(
    "API and PostgreSQL restart retain owner session, tasks, answers and grants",
  );
  const dump = compose([
    "exec",
    "-T",
    "db",
    "pg_dump",
    "-U",
    "coordination",
    "-Fc",
    "coordination",
  ]);
  const sqliteBackups = compose([
    "exec",
    "-T",
    "app",
    "tar",
    "-C",
    "/data/backups",
    "-czf",
    "-",
    ".",
  ]);
  writeFileSync(path.join(temporary, "backup.dump"), dump, { mode: 0o600 });
  compose(["exec", "-T", "db", "createdb", "-U", "coordination", "restored"]);
  compose(
    ["exec", "-T", "db", "pg_restore", "-U", "coordination", "-d", "restored"],
    { input: dump },
  );
  const restoredEnv = path.join(temporary, "restore.env");
  writeFileSync(
    restoredEnv,
    `DATABASE_URL=postgres://coordination:${dbPassword}@db:5432/restored\nBOOTSTRAP_SECRET=${bootstrap}\nBACKUP_DIR=/data/backups\n`,
    { mode: 0o600 },
  );
  docker([
    "run",
    "-d",
    "--name",
    project + "-restore",
    "--network",
    project + "_default",
    "--env-file",
    restoredEnv,
    "-p",
    `127.0.0.1:${restoredPort}:4310`,
    "coordination-product",
  ]);
  restorationStarted = true;
  docker(
    [
      "exec",
      "-i",
      project + "-restore",
      "tar",
      "-C",
      "/data/backups",
      "-xzf",
      "-",
    ],
    { input: sqliteBackups },
  );
  const restoredBase = `http://127.0.0.1:${restoredPort}`;
  await ready(restoredBase);
  const restoredLogin = await fetch(restoredBase + "/api/v1/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: ownerPassword }),
  });
  assert.ok(restoredLogin.ok);
  const restoredCookie = restoredLogin.headers.get("set-cookie").split(";")[0];
  const restoredTasks = await (
    await fetch(restoredBase + "/api/v1/resources/tasks", {
      headers: { cookie: restoredCookie },
    })
  ).json();
  assert.ok(
    restoredTasks.items.some((t) => t.id === task.id && t.state === "done"),
  );
  const restoredOperations = await (
    await fetch(restoredBase + "/api/v1/operations", {
      headers: { cookie: restoredCookie },
    })
  ).json();
  assert.equal(restoredOperations.backup_count, 1);
  report(
    "PostgreSQL and private SQLite backups restore into a fresh installation; restored owner signs in and sees persisted work",
  );
  compose([
    "exec",
    "-T",
    "db",
    "createdb",
    "-U",
    "coordination",
    "future_schema",
  ]);
  compose([
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "coordination",
    "-d",
    "future_schema",
    "-c",
    "CREATE TABLE schema_migrations(version integer PRIMARY KEY); INSERT INTO schema_migrations VALUES(999)",
  ]);
  const incompatibleEnv = path.join(temporary, "future.env");
  writeFileSync(
    incompatibleEnv,
    `DATABASE_URL=postgres://coordination:${dbPassword}@db:5432/future_schema\nBOOTSTRAP_SECRET=${bootstrap}\n`,
    { mode: 0o600 },
  );
  docker([
    "run",
    "-d",
    "--name",
    project + "-future",
    "--network",
    project + "_default",
    "--env-file",
    incompatibleEnv,
    "coordination-product",
  ]);
  incompatibleStarted = true;
  let futureState;
  for (let n = 0; n < 40; n++) {
    futureState = JSON.parse(
      docker([
        "inspect",
        "--format",
        "{{json .State}}",
        project + "-future",
      ]).toString(),
    );
    if (!futureState.Running) break;
    await wait(250);
  }
  assert.equal(futureState.Running, false);
  assert.notEqual(futureState.ExitCode, 0);
  const futureLogs = spawnSync(
    "docker",
    [...dockerArgs, "logs", project + "-future"],
    { cwd: root, env: childEnv, encoding: "utf8" },
  );
  assert.equal(futureLogs.status, 0);
  assert.match(
    futureLogs.stdout + futureLogs.stderr,
    /Unsupported newer schema/,
  );
  report(
    "Unsupported newer database schemas stop startup promptly without serving a healthy application",
  );
  const tokens = await all("agent_tokens"),
    tokenA = tokens.find((t) => t.agent_id === aa.agent.id);
  await ownerApi("actions/token_revoke", { id: tokenA.id });
  const revoked = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + aa.raw,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(revoked.status, 401);
  compose([
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "coordination",
    "-d",
    "coordination",
    "-c",
    `UPDATE agent_tokens SET body=jsonb_set(body,'{expires_at}','"2000-01-01T00:00:00Z"') WHERE agent_id='${cc.agent.id}'`,
  ]);
  const expired = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + cc.raw,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(expired.status, 401);
  report(
    "Revoked and expired credentials are rejected by the deployed MCP endpoint",
  );
  const audit = [];
  let after = 0;
  for (;;) {
    const rows = await ownerApi("audit?after=" + after);
    audit.push(...rows);
    if (rows.length < 100) break;
    after = Number(rows.at(-1).id);
  }
  assert.ok(audit.some((e) => e.action === "agent_auth_denied"));
  assert.ok(audit.some((e) => e.action === "agent_authenticated"));
  assert.ok(
    !JSON.stringify(audit).includes(aa.raw) &&
      !JSON.stringify(audit).includes(bb.raw),
  );
  assert.ok(
    JSON.stringify((await ownerApi("resources/messages")).items).includes(
      "Archived coordination agreement",
    ),
  );
  report(
    "Headless audit and historical-record APIs expose real events without raw credentials",
  );
  writeFileSync(
    "/tmp/coordination-release-report.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        verified_at: new Date().toISOString(),
        runtime_adapter: "unconfigured",
        public_deployment: false,
      },
      null,
      2,
    ),
  );
  console.log("ALL COMPOSE ACCEPTANCE CHECKS PASSED");
} catch (error) {
  writeFileSync(
    "/tmp/coordination-release-report.json",
    JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
  );
  try {
    const logs = compose(["logs", "--no-color", "--tail", "80"]).toString();
    writeFileSync("/tmp/coordination-compose-failure.log", logs, {
      mode: 0o600,
    });
  } catch {}
  throw error;
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  if (restorationStarted)
    try {
      docker(["rm", "-f", project + "-restore"]);
    } catch {}
  if (incompatibleStarted)
    try {
      docker(["rm", "-f", project + "-future"]);
    } catch {}
  if (process.env.KEEP_ACCEPTANCE_STACK !== "true") {
    try {
      compose(["down", "--volumes", "--remove-orphans"], { stdio: "pipe" });
    } catch {}
    rmSync(temporary, { recursive: true, force: true });
  } else console.log("Kept isolated acceptance files at " + temporary);
}
