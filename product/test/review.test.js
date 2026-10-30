import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { Service } from "../src/service.js";
import { app } from "../src/server.js";
import { dockerConnection } from "../src/docker.js";

test("Docker connection selection preserves context, TLS and registry selectors by default", () => {
  const env = {
    DOCKER_HOST: "tcp://daemon:2376",
    DOCKER_CONTEXT: "work",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/certs",
    DOCKER_CONFIG: "/config",
  };
  assert.deepEqual(dockerConnection(env), { args: [], env });
  const configured = dockerConnection(env, "unix:///explicit.sock");
  assert.deepEqual(configured.args, ["--host=unix:///explicit.sock"]);
  assert.equal(configured.env.DOCKER_CONTEXT, undefined);
  assert.equal(configured.env.DOCKER_TLS_VERIFY, "1");
  assert.equal(env.DOCKER_CONTEXT, "work");
});
test("query variations share route/method rate buckets and MCP keeps its intended allowance", async () => {
  const pool = await database(process.env.TEST_DATABASE_URL);
  const server = await app({
    pool,
    bootstrapSecret: "test-bootstrap-secret-at-least-thirty-two",
  });
  try {
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/api/v1/auth/bootstrap?attempt=" + i,
            payload: { secret: "invalid" },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/auth/bootstrap?attempt=21",
          payload: { secret: "invalid" },
        })
      ).statusCode,
      429,
    );
    for (let i = 0; i < 300; i++)
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/mcp?attempt=" + i,
            payload: {},
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/mcp?attempt=301",
          payload: {},
        })
      ).statusCode,
      429,
    );
    assert.equal(
      (
        await server.inject({
          method: "GET",
          url: "/mcp?attempt=separate-method",
        })
      ).statusCode,
      401,
    );
  } finally {
    await server.close();
    await pool.end();
  }
});
test("SQL pages remain bounded and authorized while an exclusive writer is waiting", async () => {
  const pool = await database(process.env.TEST_DATABASE_URL),
    s = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  const project = await s.execute(owner, "project_create", {
    name: "SQL paging",
  });
  const a = await s.execute(owner, "repo_create", {
    name: "Allowed",
    reference: "fixture",
    project_id: project.id,
  });
  const b = await s.execute(owner, "repo_create", {
    name: "Private",
    reference: "fixture",
    project_id: project.id,
  });
  const enrolled = await s.execute(owner, "agent_enroll", {
    name: "Reader",
    grants: [{ repo_id: a.id, permissions: ["task:read"] }],
  });
  const principal = await s.authenticate(enrolled.token);
  try {
    for (let i = 0; i < 57; i++)
      await s.execute(owner, "task_create", {
        repo_id: a.id,
        title: "Page " + i,
        description: "Fixture",
      });
    const foreign = await s.execute(owner, "task_create", {
      repo_id: b.id,
      title: "Not visible",
      description: "Private",
    });
    const first = await s.read(principal, "tasks", {
      repo_id: a.id,
      limit: 20,
    });
    const second = await s.read(principal, "tasks", {
      repo_id: a.id,
      after: first.next_cursor,
      limit: 20,
    });
    const third = await s.read(principal, "tasks", {
      repo_id: a.id,
      after: second.next_cursor,
      limit: 20,
    });
    assert.equal(first.items.length, 20);
    assert.equal(second.items.length, 20);
    assert.equal(third.items.length, 17);
    assert.equal(third.has_more, false);
    assert.equal(
      new Set(
        [...first.items, ...second.items, ...third.items].map((x) => x.id),
      ).size,
      57,
    );
    assert.equal(
      (await s.read(principal, "tasks", { id: foreign.id })).items.length,
      0,
    );
    assert.equal(
      (await s.read(principal, "tasks", { repo_id: b.id })).items.length,
      0,
    );
    const blocker = await pool.connect();
    let timer;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(431002)");
      const read = s.read(principal, "tasks", { repo_id: a.id, limit: 1 });
      const result = await Promise.race([
        read,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Read waited for mutation lock")),
            1500,
          );
        }),
      ]);
      assert.equal(result.items.length, 1);
    } finally {
      clearTimeout(timer);
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)",[owner.id,"review-"+owner.id,"not-a-login-hash"]);
    const newest = await s.notifications(owner, 0, { latest: true });
    const event = newest.at(-1);
    await s.markRead(owner, Number(event.id));
    assert.equal((await s.notifications(owner, Number(event.id))).length, 0);
    assert.ok((await s.notifications(owner, Number(event.id) - 1))[0].read_at);
  } finally {
    await pool.end();
  }
});
