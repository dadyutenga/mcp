import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { Service, permissions } from "../src/service.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("Disposable TEST_DATABASE_URL required");
async function fixture() {
  const pool = await database(url),
    s = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  const project = await s.execute(owner, "project_create", {
    name: "Domain tests",
  });
  const repo = await s.execute(owner, "repo_create", {
    project_id: project.id,
    name: "Test repo",
    reference: "local:fixture",
  });
  const enroll = async (name, perms = permissions) =>
    s.execute(owner, "agent_enroll", {
      name,
      grants: [{ repo_id: repo.id, permissions: perms }],
    });
  const a = await enroll("Agent A"),
    b = await enroll("Agent B");
  return {
    pool,
    s,
    owner,
    repo,
    a,
    b,
    pa: await s.authenticate(a.token),
    pb: await s.authenticate(b.token),
    enroll,
  };
}
test("claim ownership, explicit handoff, comments and revocation are enforced by shared domain", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa, pb, pool } = f;
    const task = await s.execute(owner, "task_create", {
      repo_id: repo.id,
      title: "Lifecycle",
      description: "Real claim and handoff",
    });
    await assert.rejects(
      s.execute(pa, "task_update", {
        id: task.id,
        version: task.version,
        progress: 10,
      }),
      /Claim/,
    );
    const a = await s.execute(pa, "task_claim", { id: task.id });
    const lease = await s.execute(pa, "reservation_acquire", {
      repo_id: repo.id,
      task_id: task.id,
      path: "Case/Sensitive.js",
    });
    await assert.rejects(
      s.execute(pb, "task_handoff", {
        id: task.id,
        version: a.version,
        to_agent: f.b.agent.id,
        reason: "Take over",
      }),
      /claimant/,
    );
    const handed = await s.execute(pa, "task_handoff", {
      id: task.id,
      version: a.version,
      to_agent: f.b.agent.id,
      reason: "Ready for review",
    });
    assert.equal(handed.claimed_by, null);
    assert.equal(
      (await s.read(owner, "file_reservations")).items.find(
        (l) => l.id === lease.id,
      ).state,
      "released",
    );
    await assert.rejects(
      s.execute(pa, "task_claim", { id: task.id }),
      /assigned/,
    );
    await s.execute(pb, "task_claim", { id: task.id });
    const commentator = await f.enroll("Commenter", [
      "task:read",
      "task:comment",
    ]);
    const pc = await s.authenticate(commentator.token);
    await s.execute(pc, "task_comment", {
      id: task.id,
      comment: "Scoped comment",
    });
    await assert.rejects(
      s.execute(pc, "task_update", {
        id: task.id,
        version: handed.version,
        progress: 50,
      }),
      /Permission/,
    );
    await s.execute(owner, "agent_revoke", { id: f.b.agent.id });
    await assert.rejects(s.read(pb, "tasks"), /revoked/);
    await assert.rejects(s.authenticate(f.b.token), /revoked/);
    assert.equal(
      (await s.read(owner, "tasks")).items.find((t) => t.id === task.id).state,
      "blocked",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM task_events WHERE body->>'task_id'=$1",
          [task.id],
        )
      ).rows[0].count,
      "5",
    );
  } finally {
    await f.pool.end();
  }
});
test("dependencies cycle-check, block claims and can be removed by owner", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa } = f;
    const make = (title) =>
      s.execute(owner, "task_create", {
        repo_id: repo.id,
        title,
        description: "Dependency test",
      });
    const a = await make("A"),
      b = await make("B");
    const edge = await s.execute(owner, "dependency_add", {
      id: a.id,
      depends_on: b.id,
    });
    await assert.rejects(
      s.execute(owner, "dependency_add", { id: b.id, depends_on: a.id }),
      /cycle/,
    );
    await assert.rejects(
      s.execute(pa, "task_claim", { id: a.id }),
      /dependency/,
    );
    await assert.rejects(
      s.execute(pa, "dependency_remove", { id: edge.id }),
      /Owner/,
    );
    await s.execute(owner, "dependency_remove", { id: edge.id });
    await s.execute(pa, "task_claim", { id: a.id });
  } finally {
    await f.pool.end();
  }
});

test("cross-repo answer notifications are delivered only to the requester, and expired grant retries are denied", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa, pb } = f;
    const other = await s.execute(owner, "repo_create", {
      project_id: repo.project_id,
      name: "Other repo",
      reference: "fixture:other",
    });
    await s.execute(owner, "grant_set", {
      agent_id: f.b.agent.id,
      repo_id: other.id,
      permissions: ["cross_repo:approve", "task:read"],
      reason: "Target responder",
    });
    const q = await s.execute(pa, "request_create", {
      repo_id: repo.id,
      target_repo: other.id,
      reason: "Need contract",
      scope: "POST /login fields",
      type: "api-contract",
    });
    await s.execute(pb, "request_decide", {
      id: q.id,
      decision: "approved",
      reason: "Exact requested scope",
    });
    await s.execute(pb, "request_answer", {
      id: q.id,
      content: '{"email":"string"}',
    });
    const events = await s.events(pa);
    assert.ok(
      events.some(
        (e) => e.action === "cross_repo_answer_ready" && e.resource_id === q.id,
      ),
    );
    const bystander = await f.enroll("Bystander");
    const outsider = await s.authenticate(bystander.token);
    assert.ok(
      !(await s.events(outsider)).some(
        (e) => e.action === "cross_repo_answer_ready" && e.resource_id === q.id,
      ),
    );
    assert.ok(
      !(await s.read(outsider, "cross_repo_responses")).items.some(
        (r) => r.request_id === q.id,
      ),
    );
  } finally {
    await f.pool.end();
  }
});

test("incoming request events reach a target-only delegate and target-scoped request lists", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa } = f;
    const target = await s.execute(owner, "repo_create", {
      project_id: repo.project_id,
      name: "Backend inbox",
      reference: "fixture:backend-inbox",
    });
    const worker = await s.execute(owner, "agent_enroll", {
      name: "Backend only",
      grants: [
        {
          repo_id: target.id,
          permissions: ["task:read", "cross_repo:approve"],
        },
      ],
    });
    const backend = await s.authenticate(worker.token);
    const request = await s.execute(pa, "request_create", {
      repo_id: repo.id,
      target_repo: target.id,
      type: "api-contract",
      reason: "Google driver login",
      scope: "POST /auth/google driver account role",
    });
    assert.ok(
      (await s.events(backend)).some(
        (e) => e.resource_id === request.id && e.action === "request_create",
      ),
      "Backend must receive an event for a request created by the driver repo",
    );
    assert.ok(
      (
        await s.read(backend, "cross_repo_requests", { repo_id: target.id })
      ).items.some((q) => q.id === request.id),
    );
    assert.ok(
      (await s.inbox(backend, { repo_id: target.id })).items.some(
        (q) => q.id === request.id,
      ),
    );
    assert.equal(
      (await s.inbox(pa)).items.length,
      0,
      "Source requesters must not receive their own outgoing request as incoming",
    );
    const reader = await s.execute(owner, "agent_enroll", {
      name: "Target reader without approval",
      grants: [{ repo_id: target.id, permissions: ["task:read"] }],
    });
    const readOnly = await s.authenticate(reader.token);
    assert.equal((await s.inbox(readOnly)).items.length, 0);
    assert.ok(
      !(await s.events(readOnly)).some((e) => e.resource_id === request.id),
    );
    await s.execute(pa, "request_clarify", {
      id: request.id,
      clarification: "Android driver package needs a driver-role response",
    });
    assert.ok(
      (await s.events(backend)).some(
        (e) => e.resource_id === request.id && e.action === "request_clarify",
      ),
    );
    await s.execute(backend, "request_decide", {
      id: request.id,
      decision: "approved",
      reason: "Exact endpoint contract",
    });
    await s.execute(backend, "request_answer", {
      id: request.id,
      content: "Fixture contract response",
    });
    assert.equal(
      (await s.inbox(backend)).items.length,
      0,
      "Answered requests leave the actionable inbox",
    );
  } finally {
    await f.pool.end();
  }
});

test("request clarification, bounded reference scope and requester withdrawal retain an auditable decision trail", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa, pb } = f;
    const target = await s.execute(owner, "repo_create", {
      project_id: repo.project_id,
      name: "Target",
      reference: "fixture:target",
    });
    await s.execute(owner, "grant_set", {
      agent_id: f.b.agent.id,
      repo_id: target.id,
      permissions: ["cross_repo:approve"],
      reason: "Scoped approver",
    });
    await assert.rejects(
      s.execute(pa, "request_create", {
        repo_id: repo.id,
        target_repo: target.id,
        reason: "Too broad",
        scope: "entire repository",
        type: "excerpt",
      }),
      /exact endpoint/,
    );
    let q = await s.execute(pa, "request_create", {
      repo_id: repo.id,
      target_repo: target.id,
      reason: "Login endpoint",
      scope: "src/login.ts request shape",
      requested_paths: ["src/login.ts"],
      type: "excerpt",
    });
    await s.execute(pb, "request_decide", {
      id: q.id,
      decision: "needs-input",
      reason: "Specify response format",
    });
    q = await s.execute(pa, "request_clarify", {
      id: q.id,
      clarification: "JSON request and response only",
    });
    assert.equal(q.state, "pending");
    await s.execute(pb, "request_decide", {
      id: q.id,
      decision: "approved",
      reason: "Exact path only",
    });
    await assert.rejects(
      s.execute(pb, "request_answer", {
        id: q.id,
        content: "Other file",
        reference: { path: "src/private.ts", commit: "a".repeat(40) },
      }),
      /outside the approved/,
    );
    await s.execute(pa, "request_decide", {
      id: q.id,
      decision: "revoked",
      reason: "No longer needed",
    });
    const final = (await s.read(owner, "cross_repo_requests")).items.find(
      (r) => r.id === q.id,
    );
    assert.deepEqual(
      final.history.map((h) => h.state),
      ["pending", "needs-input", "pending", "approved", "revoked"],
    );
  } finally {
    await f.pool.end();
  }
});

test("expired leases can be reacquired and cancellation releases active intent without erasing history", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa, pb, pool } = f;
    const make = (title) =>
      s.execute(owner, "task_create", {
        repo_id: repo.id,
        title,
        description: "Expiry and cancellation",
      });
    let a = await make("A lease"),
      b = await make("B lease");
    a = await s.execute(pa, "task_claim", { id: a.id });
    b = await s.execute(pb, "task_claim", { id: b.id });
    const old = await s.execute(pa, "reservation_acquire", {
      repo_id: repo.id,
      task_id: a.id,
      path: "src/API.ts",
      seconds: 30,
    });
    await pool.query(
      "UPDATE file_reservations SET body=jsonb_set(body,'{expires_at}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
      [old.id],
    );
    const lease = await s.execute(pb, "reservation_acquire", {
      repo_id: repo.id,
      task_id: b.id,
      path: "src/API.ts",
    });
    assert.equal(
      (await s.read(owner, "file_reservations")).items.find(
        (l) => l.id === old.id,
      ).state,
      "expired",
    );
    await s.execute(owner, "task_update", {
      id: b.id,
      version: b.version,
      state: "cancelled",
    });
    assert.equal(
      (await s.read(owner, "file_reservations")).items.find(
        (l) => l.id === lease.id,
      ).state,
      "released",
    );
    await assert.rejects(
      s.execute(pb, "task_update", {
        id: b.id,
        version: b.version + 1,
        progress: 50,
      }),
      /closed/,
    );
    assert.ok(
      (await s.read(owner, "task_events")).items.some(
        (e) => e.task_id === b.id && e.state === "cancelled",
      ),
    );
  } finally {
    await f.pool.end();
  }
});

test("agent list summaries and explicit scoped getters stay bounded; oversized writes roll back", async () => {
  const f = await fixture();
  try {
    const { s, owner, repo, pa, pb } = f;
    const context = await s.execute(pa, "context_publish", {
      repo_id: repo.id,
      key: "bounded-contract",
      content: "x".repeat(2000),
      permitted_repos: [repo.id],
    });
    const summary = (await s.read(pb, "shared_context_items")).items.find(
      (c) => c.id === context.id,
    );
    assert.equal(summary.truncated, true);
    assert.equal(summary.content.length, 321);
    assert.equal(
      (await s.resource(pb, "shared_context_items", context.id)).content.length,
      2000,
    );
    await assert.rejects(
      s.execute(pa, "context_publish", {
        repo_id: repo.id,
        key: "too-large",
        content: "界".repeat(9000),
        permitted_repos: [repo.id],
      }),
      /24 KiB/,
    );
    assert.ok(
      !(await s.read(owner, "shared_context_items")).items.some(
        (c) => c.key === "too-large" && c.repo_id === repo.id,
      ),
    );
    await assert.rejects(s.read(pb, "tasks", { limit: 51 }), /Page limit/);
    const outsiderProject = await s.execute(owner, "project_create", {
        name: "Unrelated",
      }),
      outsiderRepo = await s.execute(owner, "repo_create", {
        project_id: outsiderProject.id,
        name: "Private",
        reference: "fixture:private",
      });
    const privateContext = await s.execute(owner, "context_publish", {
      repo_id: outsiderRepo.id,
      key: "private",
      content: "Unrelated context",
      permitted_repos: [outsiderRepo.id],
    });
    await assert.rejects(
      s.resource(pb, "shared_context_items", privateContext.id),
      /unauthorized/,
    );
  } finally {
    await f.pool.end();
  }
});

test("database setup rejects missing and placeholder configuration without exposing credentials", async () => {
  await assert.rejects(database(undefined), /Set DATABASE_URL/);
  await assert.rejects(
    database("postgres://operator:REPLACE_WITH_RANDOM_HEX@127.0.0.1/database"),
    /non-placeholder/,
  );
  await assert.rejects(
    database("https://operator:credential@127.0.0.1/database"),
    /PostgreSQL password/,
  );
});

test("identity reports only current effective repo grants", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.s.identity(f.pa)).grants.length, 1);
    await f.s.execute(f.owner, "grant_set", {
      agent_id: f.a.agent.id,
      repo_id: f.repo.id,
      permissions: ["task:read"],
      expires_at: "2000-01-01T00:00:00Z",
      reason: "Expired scope fixture",
    });
    assert.deepEqual((await f.s.identity(f.pa)).grants, []);
  } finally {
    await f.pool.end();
  }
});

test(
  "unsupported newer schemas fail promptly and release the migration connection",
  { timeout: 10000 },
  async () => {
    const { default: pg } = await import("pg");
    const admin = new pg.Pool({ connectionString: url });
    const schema = "newer_" + randomUUID().replaceAll("-", "");
    try {
      await admin.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".schema_migrations(version integer PRIMARY KEY); INSERT INTO "${schema}".schema_migrations VALUES(999)`,
      );
      const isolated = new URL(url);
      isolated.searchParams.set("options", "-c search_path=" + schema);
      await assert.rejects(
        database(isolated.toString()),
        /Unsupported newer schema/,
      );
      assert.equal(
        Number(
          (
            await admin.query(
              `SELECT version FROM "${schema}".schema_migrations`,
            )
          ).rows[0].version,
        ),
        999,
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
