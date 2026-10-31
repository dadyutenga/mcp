import test from "node:test";
import assert from "node:assert/strict";
import { Workspaces } from "../src/workspaces.js";

const ok = (value) => ({ structuredContent: { result: value } });
function fixture(run) {
  const workspaces = new Workspaces(null, null, "fixture"),
    calls = [];
  for (const repo_id of ["driver", "backend"])
    workspaces.sessions.set(repo_id, {
      repo_id,
      agent_id: repo_id + "-agent",
      repository: { name: repo_id },
      client: {
        async callTool(params) {
          calls.push({ repo_id, ...params });
          return run(repo_id, params);
        },
      },
    });
  return { workspaces, calls };
}

test("selecting a compatibility default leaves both repositories active and reads aggregated", async () => {
  const { workspaces } = fixture((repo_id) =>
    ok({ items: [{ id: repo_id, repo_id }] }),
  );
  workspaces.select("driver");
  assert.deepEqual(workspaces.status().active_repo_ids, ["driver", "backend"]);
  const result = await workspaces.call({ name: "tasks_list", arguments: {} });
  assert.deepEqual(
    result.structuredContent.result.items.map((x) => x.id),
    ["backend", "driver"],
  );
});

test("unknown task IDs are discovered with reads and exactly one worker performs the mutation", async () => {
  const { workspaces, calls } = fixture((repo_id, params) => {
    if (params.name === "tasks_get")
      return repo_id === "backend"
        ? ok({ id: "task", repo_id })
        : { isError: true };
    assert.equal(params.name, "task_claim");
    return ok({ id: "task", repo_id, claimed_by: repo_id + "-agent" });
  });
  const response = await workspaces.call({
    name: "task_claim",
    arguments: { input: { id: "task" } },
  });
  assert.equal(response.structuredContent.result.claimed_by, "backend-agent");
  assert.equal(calls.filter((c) => c.name === "tasks_get").length, 2);
  assert.deepEqual(
    calls.filter((c) => c.name === "task_claim").map((c) => c.repo_id),
    ["backend"],
  );
});

test("unscoped creation and unknown repositories never broadcast a write", async () => {
  const { workspaces, calls } = fixture(() => {
    throw Error("Must not call a worker");
  });
  assert.equal(
    (
      await workspaces.call({
        name: "task_create",
        arguments: { input: { title: "Which repo?" } },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await workspaces.call({
        name: "task_create",
        arguments: { input: { repo_id: "unknown" } },
      })
    ).isError,
    true,
  );
  assert.equal(calls.length, 0);
});

test("request decisions and answers use the target; clarification and requester withdrawal use the source", async () => {
  const { workspaces, calls } = fixture((repo_id, params) =>
    ok({ id: "answer", repo_id }),
  );
  const request = {
    id: "question",
    repo_id: "driver",
    target_repo: "backend",
    requester: "driver-agent",
  };
  workspaces.remember("request_create", request);
  for (const [name, decision] of [
    ["request_decide", "approved"],
    ["request_answer"],
    ["request_clarify"],
    ["request_decide", "revoked"],
  ]) {
    await workspaces.call({
      name,
      arguments: {
        input: { id: request.id, ...(decision ? { decision } : {}) },
      },
    });
  }
  assert.deepEqual(
    calls.map((c) => c.repo_id),
    ["backend", "backend", "driver", "driver"],
  );
});

test("merged lists deduplicate, obey a global limit and expose partial failures", async () => {
  const { workspaces } = fixture((repo_id) =>
    repo_id === "backend"
      ? { isError: true, content: [{ text: "Permission denied" }] }
      : ok({ items: [{ id: "a" }, { id: "b" }, { id: "c" }], has_more: false }),
  );
  const page = (
    await workspaces.call({ name: "tasks_list", arguments: { limit: 2 } })
  ).structuredContent.result;
  assert.deepEqual(
    page.items.map((x) => x.id),
    ["a", "b"],
  );
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, "b");
  assert.equal(page.workspace_errors[0].repo_id, "backend");
  workspaces.sessions.get("backend").client.callTool = async () =>
    ok({ items: [{ id: "a" }, { id: "d" }] });
  assert.deepEqual(
    (
      await workspaces.call({ name: "tasks_list", arguments: {} })
    ).structuredContent.result.items.map((x) => x.id),
    ["a", "b", "c", "d"],
  );
});
