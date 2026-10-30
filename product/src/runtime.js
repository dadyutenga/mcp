import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  lstat,
  rename,
  unlink,
  rm,
  chmod,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { transaction, connectionTransaction, get, put, hydrate } from "./db.js";
import { Fault, normalizePath } from "./service.js";
import { rejectSecrets } from "./secrets.js";
import { dockerConnection } from "./docker.js";
const exec = promisify(execFile);
// Leave pool capacity for ordinary service requests while Docker is slow.
const dockerCapacity = new WeakMap();

// Source attributes/configuration must not activate operator Git filters/hooks.
const gitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});
const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "uploadpack.packObjectsHook=",
];

const profileSchema = z
  .object({
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/),
    command: z.array(z.string().min(1).max(4000)).min(1).max(50),
    max_seconds: z.number().int().min(30).max(86400).default(3600),
    network: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
      .refine((value) => value !== "host", "Use a dedicated Docker network")
      .default("none"),
    env_file: z.string().refine(path.isAbsolute).optional(),
    ca_file: z.string().refine(path.isAbsolute).optional(),
    memory_mb: z.number().int().min(128).max(32768).default(512),
    cpus: z.number().min(0.1).max(16).default(1),
  })
  .strict();
const configSchema = z
  .object({
    root: z.string().min(1),
    repositories: z.record(z.uuid(), z.string().min(1)),
    profiles: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
      profileSchema,
    ),
  })
  .strict();
const filesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1).max(500),
        content: z.string().max(16000).nullable(),
      })
      .strict(),
  )
  .min(1)
  .max(20);
const active = ["preparing", "running", "paused"];
const error = (code, message) => {
  throw new Fault(code, message);
};
export async function loadRuntimeConfig(
  file = process.env.COORDINATION_RUNTIME_CONFIG,
) {
  if (!file) return null;
  return configSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
async function readableSnapshot(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await readableSnapshot(file);
    else if (entry.isFile())
      await chmod(file, (await lstat(file)).mode & 0o111 ? 0o755 : 0o644);
  }
}
// Runs only operator-configured images/commands. No host shell, provider login,
// implicit operator credentials, Docker socket, or other repo is exposed to workers.
export class DockerRuntime {
  constructor(pool, service, config = null) {
    this.pool = pool;
    this.service = service;
    this.config = config ? configSchema.parse(config) : null;
    this.connection = dockerConnection();
  }
  capabilities() {
    const yes = !!this.config;
    return {
      start: yes,
      pause: yes,
      resume: yes,
      cancel: yes,
      isolatedWorktrees: yes,
      enforcedWrites: yes,
    };
  }
  owner(p) {
    if (!p.owner) error(403, "Owner only");
  }
  async docker(args, options = {}) {
    try {
      return (
        await exec("docker", [...this.connection.args, ...args], {
          env: this.connection.env,
          timeout: 30000,
          maxBuffer: 128 * 1024,
          ...options,
        })
      ).stdout;
    } catch (cause) {
      const fault = new Fault(
        503,
        "Docker operation failed; check the configured daemon and local image",
      );
      fault.cause = cause;
      throw fault;
    }
  }
  async git(dir, args) {
    return (
      await exec("git", [...gitOptions, "-C", dir, ...args], {
        timeout: 120000,
        maxBuffer: 128 * 1024,
        env: gitEnv(),
      })
    ).stdout.trim();
  }
  async health() {
    if (!this.config)
      return {
        available: false,
        reason:
          "Configure COORDINATION_RUNTIME_CONFIG to enable managed Docker jobs.",
        capabilities: this.capabilities(),
        profiles: [],
      };
    try {
      await this.docker(["info", "--format", "{{.ServerVersion}}"]);
      return {
        available: true,
        reason:
          "Managed Docker jobs use isolated read-only checkouts and lease-checked writes.",
        capabilities: this.capabilities(),
        profiles: Object.keys(this.config.profiles),
      };
    } catch {
      return {
        available: false,
        reason: "Configured Docker daemon unavailable.",
        capabilities: {
          start: false,
          pause: false,
          resume: false,
          cancel: false,
          isolatedWorktrees: true,
          enforcedWrites: true,
        },
        profiles: Object.keys(this.config.profiles),
      };
    }
  }
  container(id) {
    return "coordination-job-" + z.uuid().parse(id).toLowerCase();
  }
  async job(c, id) {
    const job = await get(c, "runtime_jobs", z.uuid().parse(id));
    if (!job) error(404, "Unknown runtime job");
    return job;
  }
  async authorize(c, p, job) {
    await this.service.assertPrincipal(c, p);
    if (!p.owner && p.id !== job.agent_id)
      error(403, "Job belongs to another agent");
    if (!p.owner)
      await this.service.authorize(
        c,
        { id: job.agent_id },
        job.repo_id,
        "reservation:acquire",
      );
  }
  async writable(c, job) {
    await this.service.assertPrincipal(c, { id: job.agent_id });
    const task = await get(c, "tasks", job.task_id);
    if (
      !task ||
      task.claimed_by !== job.agent_id ||
      task.state !== "in_progress"
    )
      error(409, "Job requires its agent to claim the active task");
    await this.service.authorize(
      c,
      { id: job.agent_id },
      job.repo_id,
      "reservation:acquire",
    );
    return task;
  }
  async start(p, input) {
    this.owner(p);
    if (!this.config) error(409, "Managed runtime is not configured");
    const x = z
      .object({ task_id: z.uuid(), profile: z.string() })
      .strict()
      .parse(input);
    const profile = Object.hasOwn(this.config.profiles, x.profile)
      ? this.config.profiles[x.profile]
      : null;
    if (!profile) error(400, "Unknown runtime profile");
    let job = await transaction(this.pool, async (c) => {
      const task = await get(c, "tasks", x.task_id);
      if (!task) error(404, "Unknown task");
      const source = this.config.repositories[task.repo_id];
      if (!source) error(409, "Repository has no configured local checkout");
      if (!task.claimed_by)
        error(409, "An enrolled agent must claim the task first");
      const old = await c.query(
        "SELECT 1 FROM runtime_jobs WHERE body->>'task_id'=$1 AND body->>'state'=ANY($2::text[]) LIMIT 1",
        [task.id, active],
      );
      if (old.rowCount) error(409, "Task already has an active runtime job");
      const job = {
        id: randomUUID(),
        repo_id: task.repo_id,
        project_id: task.project_id,
        agent_id: task.claimed_by,
        task_id: task.id,
        title: task.title,
        profile: x.profile,
        state: "preparing",
        expires_at: new Date(
          Date.now() + profile.max_seconds * 1000,
        ).toISOString(),
      };
      await this.writable(c, job);
      if (
        !(
          await c.query(
            "SELECT 1 FROM file_reservations WHERE agent_id=$1 AND body->>'task_id'=$2 AND body->>'state'='active' AND (body->>'expires_at')::timestamptz>now() LIMIT 1",
            [job.agent_id, job.task_id],
          )
        ).rowCount
      )
        error(
          409,
          "Acquire at least one live file reservation before launching",
        );
      const saved = await put(c, "runtime_jobs", job);
      await this.service.audit(
        c,
        p,
        "runtime_start_requested",
        job.id,
        job.repo_id,
      );
      return { ...saved, task };
    });
    let workspace;
    try {
      const root = path.resolve(this.config.root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const safeRoot = await realpath(root);
      workspace = path.join(safeRoot, job.id);
      const source = await realpath(this.config.repositories[job.repo_id]);
      await this.docker([
        "image",
        "inspect",
        profile.image,
        "--format",
        "{{.Id}}",
      ]); // Never pull an arbitrary image at launch.
      await exec(
        "git",
        [
          ...gitOptions,
          "clone",
          "--no-local",
          "--no-checkout",
          "--",
          source,
          workspace,
        ],
        { timeout: 120000, maxBuffer: 128 * 1024, env: gitEnv() },
      );
      await this.git(workspace, ["checkout", "--detach", "HEAD"]);
      await readableSnapshot(workspace);
      const commit = await this.git(workspace, ["rev-parse", "HEAD"]);
      await transaction(this.pool, async (c) => {
        const current = await this.job(c, job.id);
        await this.writable(c, current);
        await put(c, "runtime_jobs", {
          ...current,
          workspace,
          source_commit: commit,
        });
      });
      const args = [
        "run",
        "-d",
        "--name",
        this.container(job.id),
        "--label",
        "coordination.job=" + job.id,
        "--pull=never",
        "--read-only",
        "--network=" + profile.network,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=" + profile.memory_mb + "m",
        "--cpus=" + profile.cpus,
        "--user=65534:65534",
        "--init",
        "--log-driver=local",
        "--log-opt=max-size=1m",
        "--log-opt=max-file=2",
        "--tmpfs",
        "/tmp:rw,nosuid,noexec,size=64m",
        "--mount",
        `type=bind,source=${workspace},target=/workspace,readonly`,
        "--workdir",
        "/workspace",
      ];
      const explicitEnv = new Set();
      if (profile.env_file) {
        const envFile = await realpath(profile.env_file);
        if (!(await lstat(envFile)).isFile())
          error(400, "Worker env_file must be a regular file");
        const content = await readFile(envFile, "utf8");
        if (Buffer.byteLength(content) > 65536)
          error(413, "Worker environment exceeds 64 KiB");
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim() || line.trimStart().startsWith("#")) continue;
          const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=/);
          if (!match)
            error(
              400,
              "Worker environment entries must use explicit NAME=value syntax",
            );
          explicitEnv.add(match[1]);
        }
        args.push("--env-file", envFile);
      }
      if (profile.ca_file) {
        const cert = await realpath(profile.ca_file);
        if (!(await lstat(cert)).isFile())
          error(400, "Worker ca_file must be a regular certificate file");
        args.push(
          "--mount",
          `type=bind,source=${cert},target=/run/coordination-ca.pem,readonly`,
          "--env",
          "NODE_EXTRA_CA_CERTS=/run/coordination-ca.pem",
        );
      }
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "FTP_PROXY",
        "NO_PROXY",
      ])
        for (const name of [key, key.toLowerCase()])
          if (!explicitEnv.has(name)) args.push("--env", name + "=");
      args.push(
        "--env",
        "COORDINATION_TASK_JSON=" +
          JSON.stringify({
            id: job.task_id,
            title: job.task.title,
            description: job.task.description,
          }),
        profile.image,
        ...profile.command,
      );
      await this.docker(args);
      return await transaction(this.pool, async (c) => {
        const current = await this.job(c, job.id);
        await this.writable(c, current);
        const saved = await put(c, "runtime_jobs", {
          ...current,
          state: "running",
        });
        await this.service.audit(c, p, "runtime_started", job.id, job.repo_id);
        return saved;
      });
    } catch (cause) {
      await this.docker(["rm", "-f", this.container(job.id)]).catch(() => {});
      await transaction(this.pool, async (c) => {
        const current = await this.job(c, job.id);
        await put(c, "runtime_jobs", {
          ...current,
          state: "failed",
          failure: "Launch failed; verify local checkout, profile and daemon.",
        });
        await this.service.audit(c, p, "runtime_failed", job.id, job.repo_id);
      });
      if (workspace) await rm(workspace, { recursive: true, force: true });
      throw cause instanceof Fault
        ? cause
        : new Fault(
            409,
            "Runtime launch failed; verify the configured local checkout",
          );
    }
  }
  async inspect(job) {
    let data;
    try {
      data = JSON.parse(
        await this.docker([
          "inspect",
          this.container(job.id),
          "--format",
          "{{json .}}",
        ]),
      );
    } catch (error) {
      if (/No such (?:object|container)/i.test(error.cause?.stderr || ""))
        return null;
      throw error;
    }
    if (data.Config.Labels?.["coordination.job"] !== job.id)
      error(409, "Container identity does not match this job");
    return data.State;
  }
  async withJobLock(id, run, busy) {
    id = z.uuid().parse(id).toLowerCase();
    let capacity = dockerCapacity.get(this.pool);
    if (!capacity) {
      capacity = {
        used: 0,
        max: Math.max(0, Math.min(2, (this.pool.options?.max ?? 10) - 1)),
      };
      dockerCapacity.set(this.pool, capacity);
    }
    if (capacity.used >= capacity.max) return busy();
    capacity.used++;
    let c,
      locked = false,
      discard = false;
    try {
      c = await this.pool.connect();
      locked = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,431003)) AS locked",
          [id],
        )
      ).rows[0].locked;
      if (!locked) return busy();
      // This is a session lock, not a transaction. All SQL transactions below
      // finish before invoking Docker, and only brief persistence uses 431002.
      return await run(c);
    } finally {
      if (locked) {
        try {
          discard = !(
            await c.query(
              "SELECT pg_advisory_unlock(hashtextextended($1,431003)) AS unlocked",
              [id],
            )
          ).rows[0].unlocked;
        } catch {
          discard = true;
        }
      }
      c?.release(discard);
      capacity.used--;
    }
  }
  async observedJob(c, p, id, write = false) {
    return connectionTransaction(
      c,
      async (client) => {
        const job = await this.job(client, id);
        await this.authorize(client, p, job);
        if (write) await this.writable(client, job);
        return job;
      },
      { readOnly: true },
    );
  }
  async persistObserved(c, job, changes) {
    const result = await c.query(
      "UPDATE runtime_jobs SET body=body || $1::jsonb,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 AND body->>'state'=$4 RETURNING *",
      [changes, job.id, job.version, job.state],
    );
    return hydrate(result.rows[0]);
  }
  async status(p, id) {
    const cached = await transaction(
      this.pool,
      async (c) => {
        const job = await this.job(c, id);
        await this.authorize(c, p, job);
        return job;
      },
      { readOnly: true },
    );
    if (!active.includes(cached.state)) return cached;
    return this.withJobLock(
      id,
      async (c) => {
        const job = await this.observedJob(c, p, id);
        if (!active.includes(job.state)) return job;
        let actual;
        try {
          actual = await this.inspect(job);
        } catch (e) {
          if (
            job.state === "preparing" &&
            Date.now() - Date.parse(job.created_at) < 300000
          )
            return this.observedJob(c, p, id);
          throw e;
        }
        if (
          !actual &&
          job.state === "preparing" &&
          Date.now() - Date.parse(job.created_at) < 300000
        )
          return this.observedJob(c, p, id);
        const next = !actual
          ? "failed"
          : actual.Paused
            ? "paused"
            : actual.Running
              ? "running"
              : "exited";
        if (next === job.state) return this.observedJob(c, p, id);
        return connectionTransaction(c, async (client) => {
          await this.authorize(client, p, await this.job(client, id));
          const saved = await this.persistObserved(client, job, {
            state: next,
            ...(!actual
              ? {
                  failure:
                    "Managed container is missing; inspect the retained checkout.",
                }
              : { exit_code: actual.ExitCode }),
          });
          if (!saved) return this.job(client, id);
          await this.service.audit(
            client,
            p,
            "runtime_" + next,
            id,
            job.repo_id,
          );
          return saved;
        });
      },
      () => ({ ...cached, refresh_pending: true }),
    );
  }
  async control(p, id, action) {
    this.owner(p);
    if (!["pause", "resume", "cancel"].includes(action))
      error(400, "Unknown runtime control");
    return this.withJobLock(
      id,
      async (c) => {
        const job = await this.observedJob(c, p, id);
        if (action === "cancel" && job.state === "cancelled") return job;
        if (!active.includes(job.state) || job.state === "preparing")
          error(409, "Job is not available for this control");
        if (
          (action === "pause" && job.state !== "running") ||
          (action === "resume" && job.state !== "paused")
        )
          error(409, "Invalid runtime transition");
        if (action !== "cancel") await this.observedJob(c, p, id, true);
        const actual = (await this.inspect(job)) || {
          Running: false,
          Paused: false,
        };
        if (action !== "cancel" && !actual.Running)
          error(409, "Worker is not running; refresh its status");
        if (action === "cancel" && actual.Paused)
          await this.docker(["unpause", this.container(id)]);
        if (action !== "cancel" || actual.Running)
          await this.docker([
            action === "pause"
              ? "pause"
              : action === "resume"
                ? "unpause"
                : "kill",
            this.container(id),
          ]);
        return connectionTransaction(c, async (client) => {
          const current = await this.job(client, id);
          await this.authorize(client, p, current);
          if (action !== "cancel") await this.writable(client, current);
          const saved = await this.persistObserved(client, job, {
            state:
              action === "pause"
                ? "paused"
                : action === "resume"
                  ? "running"
                  : "cancelled",
          });
          if (!saved)
            error(
              409,
              "Job changed during the Docker operation; refresh its status",
            );
          if (action === "cancel") {
            const task = await get(client, "tasks", job.task_id);
            if (
              task?.claimed_by === job.agent_id &&
              task.state === "in_progress"
            ) {
              await put(client, "tasks", { ...task, state: "blocked" });
              await put(client, "task_events", {
                id: randomUUID(),
                repo_id: job.repo_id,
                task_id: job.task_id,
                agent_id: job.agent_id,
                action: "runtime_cancelled",
                state: "blocked",
                comment:
                  "Managed worker cancelled; review its isolated diff before restarting.",
              });
            }
            await client.query(
              "UPDATE file_reservations SET body=jsonb_set(body,'{state}','\"released\"') WHERE agent_id=$1 AND body->>'task_id'=$2 AND body->>'state'='active'",
              [job.agent_id, job.task_id],
            );
          }

          await this.service.audit(
            client,
            p,
            "runtime_" + action,
            id,
            job.repo_id,
          );
          return saved;
        });
      },
      () => error(409, "A runtime operation is in progress; retry shortly"),
    );
  }
  async contained(workspace, input) {
    const normalized = normalizePath(input);
    if (normalized.split("/").some((part) => part.toLowerCase() === ".git"))
      error(400, "Git metadata cannot be written");
    const root = await realpath(workspace);
    let current = root;
    const parts = normalized.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const info = await lstat(current).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (info?.isSymbolicLink())
        error(400, "Symlinks cannot be traversed or replaced");
      if (i < parts.length - 1 && info && !info.isDirectory())
        error(400, "Path parent is not a directory");
      if (i === parts.length - 1 && info && !info.isFile())
        error(400, "Select a regular file");
    }
    return current;
  }
  async apply(p, id, input) {
    const files = filesSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(files)) > 24576)
      error(413, "Runtime write batch exceeds 24 KiB");
    rejectSecrets(files);
    const completed = [];
    // Persist intent separately: after a host crash the operator can reconcile the
    // isolated diff against this record. No patch is promoted to the source repo.
    await transaction(this.pool, async (c) => {
      const job = await this.job(c, id);
      await this.authorize(c, p, job);
      await this.writable(c, job);
      await this.service.audit(
        c,
        p,
        "runtime_write_requested",
        id,
        job.repo_id,
        { paths: files.map((f) => f.path) },
      );
    });
    return transaction(this.pool, async (c) => {
      const job = await this.job(c, id);
      await this.authorize(c, p, job);
      await this.writable(c, job);
      if (
        !["running", "paused", "exited"].includes(job.state) ||
        !job.workspace
      )
        error(409, "Job has no writable managed checkout");
      const repo = await get(c, "repositories", job.repo_id);
      const leases = (
        await c.query(
          "SELECT * FROM file_reservations WHERE agent_id=$1 AND repo_id=$2 AND body->>'task_id'=$3 AND body->>'state'='active' AND (body->>'expires_at')::timestamptz>now()",
          [job.agent_id, job.repo_id, job.task_id],
        )
      ).rows.map(hydrate);
      const seen = new Set(),
        changes = [];
      for (const file of files) {
        const normalized = normalizePath(file.path, repo.case_sensitive);
        if (seen.has(normalized)) error(400, "Duplicate runtime path");
        seen.add(normalized);
        if (
          !leases.some(
            (l) =>
              normalized === l.normalized ||
              normalized.startsWith(l.normalized + "/"),
          )
        )
          error(403, "A live reservation for every written path is required");
        const target = await this.contained(job.workspace, file.path);
        const original = await readFile(target).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        const mode = (await lstat(target).catch(() => null))?.mode;
        changes.push({
          ...file,
          target,
          original,
          mode: mode === undefined ? 0o644 : mode & 0o777,
        });
      }
      // Validate the whole batch before touching disk. Workers only have a read-only mount.
      try {
        for (const change of changes) {
          await mkdir(path.dirname(change.target), {
            recursive: true,
            mode: 0o755,
          });
          let parent = job.workspace;
          for (const part of path
            .relative(job.workspace, path.dirname(change.target))
            .split(path.sep)
            .filter(Boolean)) {
            parent = path.join(parent, part);
            await chmod(parent, 0o755);
          }
          if (change.content === null) {
            await unlink(change.target).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            });
          } else {
            const temp = path.join(
              path.dirname(change.target),
              ".coordination-" + randomUUID(),
            );
            try {
              await writeFile(temp, change.content, {
                mode: change.mode,
                flag: "wx",
              });
              await chmod(temp, change.mode);
              await rename(temp, change.target);
            } finally {
              await unlink(temp).catch(() => {});
            }
          }
          completed.push(change);
          if (change.content !== null)
            await this.git(job.workspace, [
              "add",
              "--intent-to-add",
              "--",
              change.path,
            ]);
        }
        await this.service.audit(
          c,
          p,
          "runtime_files_written",
          id,
          job.repo_id,
          { paths: files.map((f) => f.path) },
        );
        return { written: files.map((f) => f.path), enforced: true };
      } catch (e) {
        for (const change of completed.reverse()) {
          if (change.original === null)
            await unlink(change.target).catch(() => {});
          else await writeFile(change.target, change.original);
        }
        throw e;
      }
    });
  }
  async reconcile() {
    const jobs = (
      await this.pool.query(
        "SELECT * FROM runtime_jobs WHERE body->>'state'=ANY($1::text[]) ORDER BY id LIMIT 100",
        [active],
      )
    ).rows.map(hydrate);
    for (const job of jobs) {
      if (job.state === "preparing") {
        if (Date.now() - Date.parse(job.created_at) > 300000)
          await this.status(
            { id: "runtime-supervisor", owner: true },
            job.id,
          ).catch(() => {});
        continue;
      }
      try {
        const task = await get(this.pool, "tasks", job.task_id),
          agent = await get(this.pool, "agents", job.agent_id);
        const revoked =
          !agent ||
          agent.revoked ||
          !task ||
          task.claimed_by !== job.agent_id ||
          ["done", "cancelled"].includes(task.state) ||
          Date.parse(job.expires_at) <= Date.now();
        if (revoked)
          await this.control(
            { id: "runtime-supervisor", owner: true },
            job.id,
            "cancel",
          );
        else
          await this.status({ id: "runtime-supervisor", owner: true }, job.id);
      } catch {
        /* Daemon outages must not fabricate a successful control or lose the job. */
      }
    }
  }
  async output(p, id) {
    this.owner(p);
    const job = await this.status(p, id);
    const text = await this.docker([
      "logs",
      "--tail",
      "100",
      this.container(id),
    ]);
    rejectSecrets({ content: text });
    return { output: text };
  }
  async collect(p, id) {
    this.owner(p);
    const { output } = await this.output(p, id);
    let result;
    try {
      result = JSON.parse(output.trim().split("\n").at(-1));
    } catch {
      error(400, "Worker must print a final JSON object with a files array");
    }
    return this.apply(p, id, result?.files);
  }
  async diff(p, id) {
    return transaction(
      this.pool,
      async (c) => {
        const job = await this.job(c, id);
        await this.authorize(c, p, job);
        if (!job.workspace) error(409, "Job has no checkout");
        const diff = await this.git(job.workspace, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "HEAD",
          "--",
        ]);
        rejectSecrets({ content: diff });
        return { diff, source_commit: job.source_commit };
      },
      { readOnly: true },
    );
  }
}
