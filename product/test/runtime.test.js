import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database, transaction, put, get } from "../src/db.js";
import { Service, permissions } from "../src/service.js";
import { DockerRuntime } from "../src/runtime.js";
import { dockerConnection } from "../src/docker.js";
import { app } from "../src/server.js";
import { hash as passwordHash } from "@node-rs/argon2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Integration gate is explicit: regular unit runs need only PostgreSQL.
// RUN_DOCKER_RUNTIME_TESTS=1 exercises actual container controls and filesystem mounts.
test(
  "managed Docker jobs enforce leases and isolate writes across pause/resume/cancel and restart",
  { skip: process.env.RUN_DOCKER_RUNTIME_TESTS !== "1" },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runtime-test-")),
      source = path.join(root, "source");
    mkdirSync(source);
    const pool = await database(process.env.TEST_DATABASE_URL),
      s = new Service(pool),
      owner = { id: randomUUID(), owner: true };
    const connection = dockerConnection();
    const docker = (args) =>
      execFileSync("docker", [...connection.args, ...args], {
        env: connection.env,
        encoding: "utf8",
      });
    const git = (args) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
    let job, runtime, server, client;
    const jobs = [];
    try {
      writeFileSync(path.join(source, "contract.txt"), "original\n");
      chmodSync(path.join(source, "contract.txt"), 0o755);
      writeFileSync(path.join(root, "outside.txt"), "outside");
      symlinkSync(
        path.join(root, "outside.txt"),
        path.join(source, "escape.txt"),
      );
      git(["init", "-q"]);
      git(["add", "."]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Fixture",
      ]);
      const project = await s.execute(owner, "project_create", {
          name: "Managed runtime",
        }),
        repo = await s.execute(owner, "repo_create", {
          project_id: project.id,
          name: "Worker source",
          reference: "fixture",
        });
      const enrolled = await s.execute(owner, "agent_enroll", {
          name: "Managed worker",
          grants: [{ repo_id: repo.id, permissions }],
        }),
        principal = await s.authenticate(enrolled.token);
      const other = await s.execute(owner, "agent_enroll", {
          name: "Other worker",
          grants: [{ repo_id: repo.id, permissions }],
        }),
        foreign = await s.authenticate(other.token);
      const task = await s.execute(owner, "task_create", {
        repo_id: repo.id,
        title: "Change contract " + owner.id,
        description: "Propose a reviewed file edit",
        assignee: principal.id,
      });
      await s.execute(principal, "task_claim", { id: task.id });
      const workerEnv = path.join(root, "worker.env");
      writeFileSync(workerEnv, "WORKER_MARKER=fixture-ok\n", { mode: 0o600 });
      const config = {
        root: path.join(root, "jobs"),
        repositories: { [repo.id]: source },
        profiles: {
          fixture: {
            image: process.env.RUNTIME_TEST_IMAGE || "coordination-product",
            env_file: workerEnv,
            ca_file: "/etc/ssl/certs/ca-certificates.crt",
            command: [
              "node",
              "-e",
              `const fs=require('node:fs');console.log('worker-env:'+process.env.WORKER_MARKER);console.log('readable:'+fs.readFileSync('/workspace/contract.txt','utf8').trim());try{fs.writeFileSync('/workspace/contract.txt','bypass')}catch(e){console.log('protected:'+e.code)};console.log(JSON.stringify({files:[{path:'contract.txt',content:'from managed worker\\n'}]}));setInterval(()=>{},1000);`,
            ],
          },
        },
      };
      runtime = new DockerRuntime(pool, s, config);
      assert.equal((await runtime.health()).available, true);
      await assert.rejects(
        runtime.start(foreign, { task_id: task.id, profile: "fixture" }),
        /Owner only/,
      );
      await assert.rejects(
        runtime.start(owner, { task_id: task.id, profile: "fixture" }),
        /reservation/,
      );
      const lease = await s.execute(principal, "reservation_acquire", {
        repo_id: repo.id,
        task_id: task.id,
        path: "contract.txt",
      });
      const username = "runtime-" + owner.id,
        password = "fixture-runtime-owner-password";
      await pool.query(
        "INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)",
        [owner.id, username, await passwordHash(password)],
      );
      server = await app({
        pool,
        bootstrapSecret: "runtime-fixture-bootstrap-thirty-two-chars",
        runtimeConfig: config,
      });
      await server.listen({ host: "127.0.0.1", port: 0 });
      const base = "http://127.0.0.1:" + server.server.address().port;
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/session",
        payload: { username, password },
      });
      const cookie = login.headers["set-cookie"].split(";")[0],
        csrf = login.json().csrf;
      async function ownerCall(route, input) {
        for (let retry = 0; retry < 20; retry++) {
          const r = await server.inject({
            method: input ? "POST" : "GET",
            url: "/api/v1/" + route,
            headers: { cookie, "x-csrf-token": csrf },
            payload: input,
          });
          if (
            r.statusCode === 409 &&
            r.json().error.message.includes("operation is in progress")
          ) {
            await wait(100);
            continue;
          }
          assert.ok(r.statusCode < 300, r.body);
          return r.json();
        }
        throw Error("Runtime control stayed busy");
      }
      job = await ownerCall("runtime/start", {
        task_id: task.id,
        profile: "fixture",
      });
      jobs.push(job);
      assert.equal(job.state, "running");
      await assert.rejects(
        runtime.start(owner, { task_id: task.id, profile: "fixture" }),
        /already has/,
      );
      let logs = "";
      for (let n = 0; n < 30; n++) {
        logs = (await runtime.output(owner, job.id)).output;
        if (logs.includes("protected:")) break;
        await wait(100);
      }
      assert.match(logs, /protected:EROFS|protected:EACCES/);
      assert.match(logs, /readable:original/);
      assert.match(logs, /worker-env:fixture-ok/);
      assert.equal(
        readFileSync(path.join(job.workspace, "contract.txt"), "utf8"),
        "original\n",
      );
      await assert.rejects(runtime.status(foreign, job.id), /another agent/);
      await assert.rejects(
        runtime.apply(principal, job.id, [
          { path: "unreserved.txt", content: "denied" },
        ]),
        /live reservation/,
      );
      assert.equal(
        (await ownerCall("runtime/" + job.id + "/pause", {})).state,
        "paused",
      );
      assert.equal(
        JSON.parse(
          docker([
            "inspect",
            runtime.container(job.id),
            "--format",
            "{{json .State}}",
          ]),
        ).Paused,
        true,
      );
      // Persisted jobs remain controllable by a newly created service/adapter instance.
      const restarted = new DockerRuntime(pool, new Service(pool), config);
      assert.equal((await restarted.status(owner, job.id)).state, "paused");
      assert.equal(
        (await ownerCall("runtime/" + job.id + "/resume", {})).state,
        "running",
      );
      assert.equal((await restarted.status(owner, job.id)).state, "running");
      client = new Client({ name: "managed-runtime-fixture", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + enrolled.token },
          },
        }),
      );
      const denied = await client.callTool({
        name: "runtime_files_write",
        arguments: {
          id: job.id,
          files: [{ path: "unreserved.txt", content: "must fail" }],
        },
      });
      assert.equal(denied.isError, true);
      const written = await client.callTool({
        name: "runtime_files_write",
        arguments: {
          id: job.id,
          files: [{ path: "contract.txt", content: "MCP-enforced write" }],
        },
      });
      assert.notEqual(written.isError, true);
      assert.equal(
        readFileSync(path.join(job.workspace, "contract.txt"), "utf8"),
        "MCP-enforced write",
      );
      await runtime.collect(owner, job.id);
      assert.equal(
        statSync(path.join(job.workspace, "contract.txt")).mode & 0o777,
        0o755,
      );
      await s.execute(principal, "reservation_acquire", {
        repo_id: repo.id,
        task_id: task.id,
        path: "generated",
      });
      await runtime.apply(principal, job.id, [
        { path: "generated/new.txt", content: "new managed file" },
      ]);
      assert.match(
        (await runtime.diff(principal, job.id)).diff,
        /generated\/new.txt/,
      );
      await runtime.apply(principal, job.id, [
        { path: "generated/new.txt", content: null },
      ]);
      assert.match(
        (await runtime.diff(principal, job.id)).diff,
        /from managed worker/,
      );
      assert.equal(
        readFileSync(path.join(source, "contract.txt"), "utf8"),
        "original\n",
      );
      await s.execute(principal, "reservation_acquire", {
        repo_id: repo.id,
        task_id: task.id,
        path: "escape.txt",
      });
      await assert.rejects(
        runtime.apply(principal, job.id, [
          { path: "escape.txt", content: "escape" },
        ]),
        /Symlinks/,
      );
      await s.execute(principal, "reservation_acquire", {
        repo_id: repo.id,
        task_id: task.id,
        path: ".git/config",
      });
      await assert.rejects(
        runtime.apply(principal, job.id, [
          { path: ".git/config", content: "escape" },
        ]),
        /Git metadata/,
      );
      await assert.rejects(
        runtime.apply(principal, job.id, [
          { path: "../outside.txt", content: "escape" },
        ]),
        /traversal/,
      );
      await pool.query(
        "UPDATE file_reservations SET body=jsonb_set(body,'{expires_at}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
        [lease.id],
      );
      await assert.rejects(
        runtime.apply(principal, job.id, [
          { path: "contract.txt", content: "expired write" },
        ]),
        /live reservation/,
      );
      await runtime.control(owner, job.id, "pause");
      assert.equal(
        (await runtime.control(owner, job.id, "cancel")).state,
        "cancelled",
      );
      assert.equal(
        JSON.parse(
          docker([
            "inspect",
            runtime.container(job.id),
            "--format",
            "{{json .State}}",
          ]),
        ).Running,
        false,
      );
      assert.equal(
        (await runtime.control(owner, job.id, "cancel")).state,
        "cancelled",
      );
      assert.equal(
        (await s.resource(owner, "tasks", task.id)).state,
        "blocked",
      );
      assert.ok(
        (
          await s.read(owner, "file_reservations", { repo_id: repo.id })
        ).items.every((x) => x.state !== "active"),
      );
      assert.equal(
        readFileSync(path.join(root, "outside.txt"), "utf8"),
        "outside",
      );
      const audit = (
        await pool.query(
          "SELECT action FROM audit_events WHERE resource_id=$1",
          [job.id],
        )
      ).rows.map((x) => x.action);
      for (const action of [
        "runtime_started",
        "runtime_pause",
        "runtime_resume",
        "runtime_cancel",
        "runtime_files_written",
      ])
        assert.ok(audit.includes(action));
      for (const reason of ["timeout", "revoked"]) {
        const nextTask = await s.execute(owner, "task_create", {
          repo_id: repo.id,
          title: "Supervisor " + reason,
          description: "Actual worker cleanup",
          assignee: principal.id,
        });
        await s.execute(principal, "task_claim", { id: nextTask.id });
        await s.execute(principal, "reservation_acquire", {
          repo_id: repo.id,
          task_id: nextTask.id,
          path: "contract.txt",
        });
        const next = await runtime.start(owner, {
          task_id: nextTask.id,
          profile: "fixture",
        });
        jobs.push(next);
        if (reason === "timeout")
          await pool.query(
            "UPDATE runtime_jobs SET body=jsonb_set(body,'{expires_at}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
            [next.id],
          );
        else await s.execute(owner, "agent_revoke", { id: principal.id });
        await runtime.reconcile();
        assert.equal((await runtime.status(owner, next.id)).state, "cancelled");
        assert.equal(
          JSON.parse(
            docker([
              "inspect",
              runtime.container(next.id),
              "--format",
              "{{json .State}}",
            ]),
          ).Running,
          false,
        );
      }
    } finally {
      if (job) await runtime.control(owner, job.id, "cancel").catch(() => {});
      await client?.close();
      await server?.close();
      for (const entry of jobs)
        try {
          docker(["rm", "-f", runtime.container(entry.id)]);
        } catch {}
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("unconfigured managed runtime reports unavailable and authenticated owner routes reject missing jobs", async () => {
  const pool = await database(process.env.TEST_DATABASE_URL);
  const server = await app({
    pool,
    bootstrapSecret: "runtime-test-bootstrap-secret-thirty-two-chars",
    runtimeConfig: null,
  });
  try {
    assert.equal((await server.runtime.health()).available, false);
    assert.equal(server.runtime.capabilities().start, false);
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/runtime/start",
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/runtime/" + randomUUID() + "/cancel",
          payload: {},
        })
      ).statusCode,
      401,
    );
  } finally {
    await server.close();
    await pool.end();
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Unrelated mutation waited for Docker")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function lockFixture() {
  const pool = await database(process.env.TEST_DATABASE_URL),
    service = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  const project = await service.execute(owner, "project_create", {
    name: "Runtime lock fixture",
  });
  const repo = await service.execute(owner, "repo_create", {
    project_id: project.id,
    name: "Fixture",
    reference: "fixture",
  });
  const enrolled = await service.execute(owner, "agent_enroll", {
    name: "Worker",
    grants: [{ repo_id: repo.id, permissions }],
  });
  const principal = await service.authenticate(enrolled.token);
  const createJob = async () => {
    const task = await service.execute(owner, "task_create", {
      repo_id: repo.id,
      title: "Fixture job",
      description: "Lock regression",
    });
    await service.execute(principal, "task_claim", { id: task.id });
    return transaction(pool, (c) =>
      put(c, "runtime_jobs", {
        id: randomUUID(),
        task_id: task.id,
        repo_id: repo.id,
        project_id: project.id,
        agent_id: principal.id,
        state: "running",
      }),
    );
  };
  return {
    pool,
    service,
    owner,
    createJob,
    runtime: new DockerRuntime(pool, service),
  };
}
test("slow inspection leaves mutations available and cannot overwrite a newer job state", async () => {
  const f = await lockFixture(),
    entered = deferred(),
    answer = deferred();
  let operation, mutation;
  try {
    const job = await f.createJob();
    f.runtime.inspect = async () => {
      entered.resolve();
      return answer.promise;
    };
    operation = f.runtime.status(f.owner, job.id);
    await entered.promise;
    mutation = f.service.execute(f.owner, "project_create", {
      name: "Available during inspection",
    });
    await promptly(mutation);
    await transaction(f.pool, async (c) => {
      const current = await get(c, "runtime_jobs", job.id);
      await put(c, "runtime_jobs", { ...current, state: "cancelled" });
    });
    answer.resolve({ Running: false, Paused: false, ExitCode: 0 });
    assert.equal((await operation).state, "cancelled");
    assert.equal(
      (await get(f.pool, "runtime_jobs", job.id)).state,
      "cancelled",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM audit_events WHERE resource_id=$1 AND action='runtime_exited'",
          [job.id],
        )
      ).rowCount,
      0,
    );
    // A metadata-only version change must also invalidate the observation.
    const newer = await f.createJob(),
      versionEntered = deferred(),
      versionAnswer = deferred();
    f.runtime.inspect = async () => {
      versionEntered.resolve();
      return versionAnswer.promise;
    };
    const versionOperation = f.runtime.status(f.owner, newer.id);
    try {
      await versionEntered.promise;
      await transaction(f.pool, async (c) => {
        const current = await get(c, "runtime_jobs", newer.id);
        await put(c, "runtime_jobs", { ...current, note: "newer metadata" });
      });
      versionAnswer.resolve({ Running: true, Paused: true, ExitCode: 0 });
      const result = await versionOperation;
      assert.equal(result.state, "running");
      assert.equal(result.note, "newer metadata");
    } finally {
      versionAnswer.resolve({ Running: true, Paused: false });
      await versionOperation.catch(() => {});
    }
  } finally {
    answer.resolve({ Running: true, Paused: false });
    await operation?.catch(() => {});
    await mutation?.catch(() => {});
    await f.pool.end();
  }
});
test("slow controls do not block service writes and reject stale completion", async () => {
  const f = await lockFixture(),
    entered = deferred(),
    answer = deferred();
  let operation, mutation;
  try {
    const job = await f.createJob();
    f.runtime.inspect = async () => ({ Running: true, Paused: false });
    f.runtime.docker = async (args) => {
      assert.equal(args[0], "pause");
      entered.resolve();
      await answer.promise;
    };
    operation = f.runtime.control(f.owner, job.id, "pause");
    operation.catch(() => {});
    await entered.promise;
    mutation = f.service.execute(f.owner, "project_create", {
      name: "Available during pause",
    });
    await promptly(mutation);
    await transaction(f.pool, async (c) => {
      const current = await get(c, "runtime_jobs", job.id);
      await put(c, "runtime_jobs", { ...current, state: "cancelled" });
    });
    answer.resolve();
    await assert.rejects(operation, /changed during the Docker operation/);
    assert.equal(
      (await get(f.pool, "runtime_jobs", job.id)).state,
      "cancelled",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM audit_events WHERE resource_id=$1 AND action='runtime_pause'",
          [job.id],
        )
      ).rowCount,
      0,
    );
  } finally {
    answer.resolve();
    await operation?.catch(() => {});
    await mutation?.catch(() => {});
    await f.pool.end();
  }
});
test("per-job locks serialize adapters without exhausting the service pool", async () => {
  const f = await lockFixture(),
    firstEntered = deferred(),
    secondEntered = deferred(),
    answer = deferred();
  let first, second, mutation;
  try {
    const one = await f.createJob(),
      two = await f.createJob(),
      three = await f.createJob();
    f.runtime.inspect = async (job) => {
      (job.id === one.id ? firstEntered : secondEntered).resolve();
      return answer.promise;
    };
    first = f.runtime.status(f.owner, one.id);
    await firstEntered.promise;
    const otherAdapter = new DockerRuntime(f.pool, f.service);
    otherAdapter.inspect = async () => {
      throw Error("Overlapping control entered Docker");
    };
    await assert.rejects(
      otherAdapter.control(f.owner, one.id.toUpperCase(), "pause"),
      /operation is in progress/,
    );
    const pending = await otherAdapter.status(f.owner, one.id);
    assert.equal(pending.refresh_pending, true);
    second = f.runtime.status(f.owner, two.id);
    await secondEntered.promise;
    const saturated = await f.runtime.status(f.owner, three.id);
    assert.equal(saturated.refresh_pending, true);
    mutation = f.service.execute(f.owner, "project_create", {
      name: "Available with saturated runtime slots",
    });
    await promptly(mutation);
    answer.resolve({ Running: true, Paused: false });
    await Promise.all([first, second]);
    otherAdapter.inspect = async () => ({ Running: true, Paused: false });
    otherAdapter.docker = async () => {};
    assert.equal(
      (await otherAdapter.control(f.owner, one.id, "pause")).state,
      "paused",
    );
  } finally {
    answer.resolve({ Running: true, Paused: false });
    await Promise.allSettled([first, second, mutation].filter(Boolean));
    await f.pool.end();
  }
});
test("failed Docker operations release the per-job lock and runtime slot", async () => {
  const f = await lockFixture();
  try {
    const job = await f.createJob();
    f.runtime.inspect = async () => {
      throw Error("Daemon unavailable");
    };
    await assert.rejects(
      f.runtime.status(f.owner, job.id),
      /Daemon unavailable/,
    );
    f.runtime.inspect = async () => ({ Running: true, Paused: false });
    f.runtime.docker = async () => {
      throw Error("Pause failed");
    };
    await assert.rejects(
      f.runtime.control(f.owner, job.id, "pause"),
      /Pause failed/,
    );
    f.runtime.docker = async () => {};
    assert.equal(
      (await f.runtime.control(f.owner, job.id, "pause")).state,
      "paused",
    );
  } finally {
    await f.pool.end();
  }
});
