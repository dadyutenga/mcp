import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { Service, permissions } from "../src/service.js";

async function fixture(run) {
  const pool = await database(process.env.TEST_DATABASE_URL),
    s = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  try {
    const project = await s.execute(owner, "project_create", {
      name: "Request workflow",
    });
    const repos = [];
    for (const name of ["driver", "backend"])
      repos.push(
        await s.execute(owner, "repo_create", {
          project_id: project.id,
          name,
          reference: "fixture:" + randomUUID(),
        }),
      );
    const enroll = async (name, repo) => {
      const agent = await s.execute(owner, "agent_enroll", {
        name,
        grants: [{ repo_id: repo.id, permissions }],
      });
      return s.authenticate(agent.token);
    };
    const source = await enroll("Requester", repos[0]),
      backend = await enroll("Backend", repos[1]),
      peer = await enroll("Other backend", repos[1]);
    const q = await s.execute(source, "request_create", {
      repo_id: repos[0].id,
      target_repo: repos[1].id,
      type: "api-contract",
      reason: "Need Google sign-in role",
      scope: "POST /auth/google account role",
    });
    await run({ pool, s, owner, source, backend, peer, q, repos });
  } finally {
    await pool.end();
  }
}
const start = async (s, p, id) => {
  const q = await s.execute(p, "request_read", { id });
  return s.execute(p, "request_work", {
    id,
    revision: q.request_revision,
    status: "working",
    note: "Inspect the named authentication endpoint and tests",
  });
};

test("separate MCP connections sharing a stable agent cannot take each other's live request claim", () =>
  fixture(async ({ s, owner, q, repos }) => {
    const enrollment = await s.execute(owner, "installation_create", {
      project_id: repos[1].project_id,
      name: "Same editor",
    });
    const installation = await s.authenticate(enrollment.token);
    const input = {
      name: "backend",
      reference: repos[1].reference,
      client: "same-editor",
    };
    const first = await s.registerWorkspace(installation, input),
      second = await s.registerWorkspace(installation, input);
    assert.equal(first.agent_id, second.agent_id);
    const a = await s.authenticate(first.token),
      b = await s.authenticate(second.token);
    await start(s, a, q.id);
    const delivered = await s.execute(b, "request_read", { id: q.id });
    assert.equal(delivered.handling.status, "assigned_elsewhere");
    await assert.rejects(
      s.execute(b, "request_work", {
        id: q.id,
        revision: delivered.request_revision,
        status: "working",
        note: "Second chat must wait",
      }),
      /already being handled/,
    );
    await s.execute(a, "request_decide", {
      id: q.id,
      decision: "approved",
      reason: "Original connection retains its read and claim",
    });
    await s.execute(a, "request_answer", {
      id: q.id,
      content: "Verified fixture response",
      evidence: "Reviewed requested endpoint fixture",
    });
  }));

test("simultaneous acknowledgements acquire exactly one handler", () =>
  fixture(async ({ s, backend, peer, q }) => {
    const reads = await Promise.all(
      [backend, peer].map((p) => s.execute(p, "request_read", { id: q.id })),
    );
    const claims = await Promise.allSettled(
      [backend, peer].map((p, index) =>
        s.execute(p, "request_work", {
          id: q.id,
          revision: reads[index].request_revision,
          status: "working",
          note: "Inspect named endpoint",
        }),
      ),
    );
    assert.equal(claims.filter((c) => c.status === "fulfilled").length, 1);
    assert.match(
      claims.find((c) => c.status === "rejected").reason.message,
      /already being handled/,
    );
  }));

test("attention filtering finds unread requests beyond a page of live work", () =>
  fixture(async ({ s, backend, source, q, repos }) => {
    const requests = [q];
    for (let i = 0; i < 21; i++)
      requests.push(
        await s.execute(source, "request_create", {
          repo_id: repos[0].id,
          target_repo: repos[1].id,
          type: "api-contract",
          reason: "Queued contract " + i,
          scope: "POST /auth/google response fields " + i,
        }),
      );
    requests.sort((a, b) => a.id.localeCompare(b.id));
    for (const request of requests.slice(0, -1))
      await start(s, backend, request.id);
    assert.ok(
      !(await s.inbox(backend, { limit: 20 })).items.some(
        (r) => r.handling.action_required,
      ),
    );
    const required = await s.inbox(backend, { attention_only: true, limit: 1 });
    assert.equal(required.items[0].id, requests.at(-1).id);
    await assert.rejects(
      s.execute(backend, "task_create", {
        repo_id: repos[1].id,
        title: "Other",
        description: "Unread request is beyond the first page",
      }),
      /COLLABORATION_ACTION_REQUIRED/,
    );
  }));

test("unread requests gate ordinary writes; inbox polling and heartbeat never acknowledge them", () =>
  fixture(async ({ s, backend, source, q, repos }) => {
    await s.setup(backend, { repo_id: repos[1].id });
    await s.inbox(backend);
    await assert.rejects(
      s.execute(backend, "task_create", {
        repo_id: repos[1].id,
        title: "Unrelated",
        description: "Cannot silently ignore requests",
      }),
      /COLLABORATION_ACTION_REQUIRED/,
    );
    await assert.rejects(
      s.execute(source, "request_read", { id: q.id }),
      /Permission/,
    );
    const read = await s.execute(backend, "request_read", { id: q.id });
    assert.equal(read.scope, q.scope);
    assert.equal(read.handling.status, "awaiting_acknowledgement");
    await assert.rejects(
      s.execute(backend, "request_decide", {
        id: q.id,
        decision: "approved",
        reason: "Skip work acknowledgement",
      }),
      /request_work/,
    );
    await s.execute(backend, "request_work", {
      id: q.id,
      revision: read.request_revision,
      status: "working",
      note: "Inspecting actual endpoint source",
    });
    const task = await s.execute(backend, "task_create", {
      repo_id: repos[1].id,
      title: "Auth contract",
      description: "Read the role mapping",
    });
    assert.ok(task.id);
    const claimed = await s.execute(backend, "task_claim", { id: task.id });
    await assert.rejects(
      s.execute(backend, "task_update", {
        id: task.id,
        version: claimed.version,
        state: "done",
        progress: 100,
      }),
      /COLLABORATION_ACTION_REQUIRED/,
    );
    const visible = await s.resource(source, "cross_repo_requests", q.id);
    assert.equal(visible.work.agent_id, backend.id);
    assert.equal(visible.work.status, "working");
  }));

test("one delegate handles a request; answers require a live claim, approval and evidence", () =>
  fixture(async ({ s, backend, peer, q, source }) => {
    await start(s, backend, q.id);
    const other = await s.execute(peer, "request_read", { id: q.id });
    await assert.rejects(
      s.execute(peer, "request_work", {
        id: q.id,
        revision: other.request_revision,
        status: "working",
        note: "Duplicate worker",
      }),
      /already being handled/,
    );
    await s.execute(backend, "request_decide", {
      id: q.id,
      decision: "approved",
      reason: "Only the requested endpoint",
    });
    await assert.rejects(
      s.execute(peer, "request_answer", {
        id: q.id,
        content: "Guess",
        evidence: "Unverified",
      }),
      /request_work|another agent/,
    );
    await assert.rejects(
      s.execute(backend, "request_answer", {
        id: q.id,
        content: "No supporting evidence",
      }),
      /evidence/,
    );
    const answer = await s.execute(backend, "request_answer", {
      id: q.id,
      content: "Fixture verified role",
      evidence: "Reviewed src/auth/google.ts and its role mapping tests",
    });
    assert.ok(answer.evidence);
    assert.equal((await s.inbox(backend)).items.length, 0);
    assert.equal(
      (await s.resource(source, "cross_repo_requests", q.id)).work.status,
      "completed",
    );
  }));

test("stalled progress resurfaces, another delegate can take over, and clarification invalidates old reads", () =>
  fixture(async ({ s, pool, backend, peer, source, q, repos }) => {
    await start(s, backend, q.id);
    await pool.query(
      "UPDATE cross_repo_requests SET body=jsonb_set(body,'{work,lease_until}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
      [q.id],
    );
    assert.equal((await s.inbox(backend)).items[0].handling.status, "overdue");
    assert.ok(
      (await s.inbox(backend, { attention_only: true })).items.some(
        (item) => item.id === q.id,
      ),
    );
    await assert.rejects(
      s.execute(backend, "task_create", {
        repo_id: repos[1].id,
        title: "Other",
        description: "Must update stalled progress",
      }),
      /COLLABORATION_ACTION_REQUIRED/,
    );
    await start(s, peer, q.id);
    await assert.rejects(
      s.execute(backend, "request_answer", {
        id: q.id,
        content: "Stale answer",
        evidence: "Old reading",
      }),
      /request_work|another agent/,
    );
    await s.execute(source, "request_clarify", {
      id: q.id,
      clarification: "Check the driver package specifically",
    });
    await assert.rejects(
      s.execute(peer, "request_work", {
        id: q.id,
        revision: 1,
        status: "working",
        note: "Old request revision",
      }),
      /request_read|revision/,
    );
    const next = await start(s, peer, q.id);
    assert.equal(next.request_revision, 2);
  }));

test("blocked work reports its reason to the requester and needs-input waits for clarification", () =>
  fixture(async ({ s, backend, source, q, repos }) => {
    const read = await s.execute(backend, "request_read", { id: q.id });
    await s.execute(backend, "request_work", {
      id: q.id,
      revision: read.request_revision,
      status: "blocked",
      note: "Need the exact Android OAuth package ID",
    });
    assert.equal(
      (await s.resource(source, "cross_repo_requests", q.id)).work.note,
      "Need the exact Android OAuth package ID",
    );
    await s.execute(backend, "request_decide", {
      id: q.id,
      decision: "needs-input",
      reason: "Supply the Android package ID",
    });
    await s.execute(backend, "task_create", {
      repo_id: repos[1].id,
      title: "Other work",
      description: "Requester has an actionable blocker",
    });
    assert.ok(
      (await s.events(source)).some(
        (e) => e.action === "cross_repo_work_updated" && e.resource_id === q.id,
      ),
    );
  }));
