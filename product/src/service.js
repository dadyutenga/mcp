import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { transaction, get, list, put } from "./db.js";
import { rejectSecrets } from "./secrets.js";
export const hash = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export const token = () => randomBytes(32).toString("base64url");
export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
const fail = (s, m) => {
  throw new Fault(s, m);
};
const narrowScope = z
  .string()
  .trim()
  .min(4)
  .max(500)
  .refine(
    (s) =>
      !/[\*]/.test(s) &&
      !/(?:entire|whole|full)\s+(?:repo|repository|source)|all\s+(?:files|source|contents)/i.test(
        s,
      ),
    "Name an exact endpoint, topic or bounded file scope",
  );
const uuid = z.uuid(),
  text = z.string().trim().min(1).max(16000),
  short = text.max(500);
export const permissions = [
  "task:read",
  "task:claim",
  "task:update",
  "task:comment",
  "reservation:acquire",
  "reservation:release",
  "context:read",
  "context:publish",
  "cross_repo:request",
  "cross_repo:approve",
];
const schemas = {
  project_create: z.object({
    name: short,
    description: text.default("Project"),
  }),
  repo_create: z.object({
    project_id: uuid,
    name: short,
    reference: short,
    default_branch: short.default("main"),
    case_sensitive: z.boolean().default(true),
  }),
  agent_enroll: z.object({
    name: short,
    existing_id: uuid.optional(),
    grants: z
      .array(
        z.object({
          repo_id: uuid,
          permissions: z.array(z.enum(permissions)).min(1),
        }),
      )
      .min(1)
      .max(30),
    expires_hours: z.number().min(1).max(8760).default(720),
  }),
  agent_revoke: z.object({ id: uuid }),
  token_revoke: z.object({ id: uuid }),
  agent_rotate: z.object({ id: uuid }),
  grant_set: z.object({
    agent_id: uuid,
    repo_id: uuid,
    permissions: z.array(z.enum(permissions)),
    expires_at: z.iso.datetime().nullable().optional(),
    reason: short,
  }),
  task_create: z.object({
    repo_id: uuid,
    title: short,
    description: text,
    priority: z.number().int().min(1).max(5).default(3),
    assignee: uuid.optional(),
    due_at: z.iso.datetime().optional(),
  }),
  task_claim: z.object({ id: uuid }),
  task_update: z.object({
    id: uuid,
    version: z.number().int().positive(),
    state: z
      .enum([
        "backlog",
        "ready",
        "in_progress",
        "blocked",
        "review",
        "done",
        "cancelled",
      ])
      .optional(),
    progress: z.number().int().min(0).max(100).optional(),
    comment: short.optional(),
    assignee: uuid.optional(),
    title: short.optional(),
    description: text.optional(),
    priority: z.number().int().min(1).max(5).optional(),
    due_at: z.iso.datetime().optional(),
  }),
  dependency_add: z.object({ id: uuid, depends_on: uuid }),
  dependency_remove: z.object({ id: uuid }),
  task_comment: z.object({ id: uuid, comment: short }),
  task_handoff: z.object({
    id: uuid,
    version: z.number().int().positive(),
    to_agent: uuid,
    reason: short,
  }),
  reservation_acquire: z.object({
    repo_id: uuid,
    task_id: uuid,
    path: short,
    seconds: z.number().int().min(30).max(3600).default(900),
  }),
  reservation_release: z.object({ id: uuid }),
  request_create: z.object({
    repo_id: uuid,
    target_repo: uuid,
    reason: short,
    scope: narrowScope,
    requested_paths: z.array(short).max(10).optional(),
    type: z.enum([
      "api-contract",
      "excerpt",
      "test-result",
      "decision",
      "help",
    ]),
    format: short.default("structured JSON"),
    task_id: uuid.optional(),
    hours: z.number().int().min(1).max(168).default(24),
  }),
  request_clarify: z.object({
    id: uuid,
    clarification: short,
    scope: narrowScope.optional(),
  }),
  request_decide: z.object({
    id: uuid,
    decision: z.enum(["approved", "denied", "needs-input", "revoked"]),
    reason: short,
  }),
  request_answer: z.object({
    id: uuid,
    content: text,
    reference: z
      .object({ path: short, commit: z.string().regex(/^[a-f0-9]{40}$/) })
      .optional(),
  }),
  context_publish: z.object({
    repo_id: uuid,
    key: short,
    content: text,
    permitted_repos: z.array(uuid).max(30),
    sensitivity: z.enum(["internal", "restricted"]).default("restricted"),
  }),
  record_update: z.object({
    kind: z.enum(["projects", "repositories"]),
    id: uuid,
    version: z.number().int().positive(),
    name: short.optional(),
    description: text.optional(),
    reference: short.optional(),
    default_branch: short.optional(),
    case_sensitive: z.boolean().optional(),
    status: z.enum(["active", "archived"]).optional(),
  }),
};
export function normalizePath(p, sensitive = true) {
  if (p.includes("\\")) p = p.replaceAll("\\", "/");
  if (
    /^[A-Za-z]:|^\/|[\x00-\x1f\x7f]/.test(p) ||
    p.split("/").some((v) => v === ".." || v === "." || !v)
  )
    fail(400, "Use a relative path without traversal or control bytes");
  return sensitive ? p : p.toLowerCase();
}
export class Service {
  constructor(pool) {
    this.pool = pool;
  }
  async assertPrincipal(c, p) {
    if (p.owner) return;
    const agent = await get(c, "agents", p.id);
    if (!agent || agent.revoked) fail(401, "Agent revoked");
    if (p.token_id) {
      const credential = await get(c, "agent_tokens", p.token_id);
      if (
        !credential ||
        credential.agent_id !== p.id ||
        credential.revoked ||
        Date.parse(credential.expires_at) <= Date.now()
      )
        fail(401, "Expired or revoked token");
    }
  }
  async authorize(c, p, repo, permission) {
    if (p.owner) return;
    const grants = await list(c, "agent_repo_grants");
    if (
      !grants.some(
        (g) =>
          g.agent_id === p.id &&
          g.repo_id === repo &&
          g.permissions.includes(permission) &&
          (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
      )
    )
      fail(403, "Permission denied");
  }
  async audit(c, p, action, id, repo = null, metadata = {}, recipient = null) {
    const r = (
      await c.query(
        "INSERT INTO audit_events(actor,action,resource_id,repo_id,request_id,metadata,recipient_agent_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [p.id, action, id, repo, p.request_id || null, metadata, recipient],
      )
    ).rows[0];
    await c.query("INSERT INTO outbox_events(id) VALUES($1)", [r.id]);
  }
  async authenticate(raw, requestId = null) {
    return transaction(this.pool, async (c) => {
      if (typeof raw !== "string" || !raw || raw.length > 256)
        fail(401, "Agent token required");
      const r = (
        await c.query("SELECT * FROM agent_tokens WHERE body->>'hash'=$1", [
          hash(raw),
        ])
      ).rows[0];
      if (!r) fail(401, "Invalid token");
      const t = { ...r.body, id: r.id, agent_id: r.agent_id };
      if (t.revoked || Date.parse(t.expires_at) <= Date.now())
        fail(401, "Expired or revoked token");
      const a = await get(c, "agents", t.agent_id);
      if (!a || a.revoked) fail(401, "Agent revoked");
      if (!t.last_used)
        await this.audit(
          c,
          { id: a.id, request_id: requestId },
          "agent_authenticated",
          t.id,
        );
      await c.query(
        "UPDATE agent_tokens SET body=jsonb_set(body,'{last_used}',to_jsonb(now()::text)) WHERE id=$1",
        [t.id],
      );
      await c.query(
        "UPDATE agents SET body=jsonb_set(body,'{heartbeat}',to_jsonb(now()::text)) WHERE id=$1",
        [a.id],
      );
      return { id: a.id, token_id: t.id };
    }).catch(async (error) => {
      if (error.statusCode === 401)
        await transaction(this.pool, (c) =>
          this.audit(
            c,
            { id: "anonymous-agent", request_id: requestId },
            "agent_auth_denied",
            null,
            null,
            { outcome: "denied" },
          ),
        ).catch(() => {});
      throw error;
    });
  }
  async read(p, kind, { after = "", limit = 50, id, full = false } = {}) {
    if (after) z.uuid().parse(after);
    if (id) z.uuid().parse(id);
    if (
      !Number.isInteger(Number(limit)) ||
      Number(limit) < 1 ||
      Number(limit) > 50
    )
      fail(400, "Page limit must be an integer from 1 to 50");
    if (
      ![
        "projects",
        "repositories",
        "agents",
        "agent_tokens",
        "agent_repo_grants",
        "tasks",
        "task_events",
        "task_dependencies",
        "file_reservations",
        "cross_repo_requests",
        "cross_repo_responses",
        "shared_context_items",
        "runtime_jobs",
        "imports",
        "messages",
        "legacy_approvals",
        "legacy_audit",
        "handoffs",
        "import_plans",
      ].includes(kind)
    )
      fail(404, "Unknown resource");
    return transaction(this.pool, async (c) => {
      await this.assertPrincipal(c, p);
      let rows = await list(c, kind);
      if (!p.owner) {
        const grants = (await list(c, "agent_repo_grants")).filter(
          (g) =>
            g.agent_id === p.id &&
            (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
        );
        const allowed = (repo, perm) =>
          grants.some(
            (g) => g.repo_id === repo && g.permissions.includes(perm),
          );
        if (
          [
            "agents",
            "agent_tokens",
            "agent_repo_grants",
            "imports",
            "runtime_jobs",
            "messages",
            "legacy_approvals",
            "legacy_audit",
            "handoffs",
            "import_plans",
          ].includes(kind)
        )
          fail(403, "Owner only");
        if (kind === "projects")
          rows = rows.filter((r) => grants.some((g) => g.project_id === r.id));
        else if (kind === "repositories")
          rows = rows.filter((r) => grants.some((g) => g.repo_id === r.id));
        else if (kind === "cross_repo_requests")
          rows = rows.filter(
            (r) =>
              (r.requester === p.id &&
                allowed(r.repo_id, "cross_repo:request")) ||
              allowed(r.target_repo, "cross_repo:approve"),
          );
        else if (kind === "cross_repo_responses") {
          const reqs = await list(c, "cross_repo_requests");
          rows = rows.filter((r) =>
            reqs.some(
              (q) =>
                q.id === r.request_id &&
                ((q.requester === p.id &&
                  allowed(q.repo_id, "cross_repo:request")) ||
                  allowed(q.target_repo, "cross_repo:approve")),
            ),
          );
        } else if (kind === "shared_context_items")
          rows = rows.filter(
            (r) =>
              allowed(r.repo_id, "context:read") ||
              r.permitted_repos.some((repo) => allowed(repo, "context:read")),
          );
        else rows = rows.filter((r) => allowed(r.repo_id, "task:read"));
      }
      rows = rows
        .filter((r) => r.id > after && (!id || r.id === id))
        .sort((a, b) => a.id.localeCompare(b.id));
      const n = Math.min(50, Math.max(1, Number(limit) || 20));
      const selected = [];
      let bytes = 0;
      for (const row of rows.slice(0, n)) {
        const x = { ...row };
        delete x.hash;
        delete x.records;
        if (x.legacy_record) {
          x.legacy_record_summary = {
            id: x.legacy_record.id,
            fields: Object.keys(x.legacy_record),
          };
          if (
            !p.owner ||
            Buffer.byteLength(JSON.stringify(x.legacy_record)) > 16000
          ) {
            delete x.legacy_record;
            x.truncated = true;
          }
        }
        if (!p.owner && full !== true && full !== "true") {
          for (const field of ["content", "description", "message", "summary"])
            if (typeof x[field] === "string" && x[field].length > 320) {
              x[field] = x[field].slice(0, 320) + "…";
              x.truncated = true;
            }
        }
        if (kind === "import_plans") {
          delete x.plan;
          if (x.preview)
            x.preview = {
              issues: x.preview.issues,
              proposed_count: x.preview.proposed?.length,
            };
        }
        if (
          kind === "cross_repo_requests" &&
          !["answered", "denied", "revoked"].includes(x.state) &&
          Date.parse(x.expires_at) <= Date.now()
        )
          x.state = "expired";
        if (
          kind === "file_reservations" &&
          x.state === "active" &&
          Date.parse(x.expires_at) <= Date.now()
        )
          x.state = "expired";
        if (Buffer.byteLength(JSON.stringify(x)) > 30000) {
          for (const field of Object.keys(x)) {
            if (typeof x[field] === "string" && x[field].length > 500)
              x[field] = x[field].slice(0, 500) + "…";
            else if (Array.isArray(x[field]) && x[field].length > 10)
              x[field] = x[field].slice(-10);
          }
          x.truncated = true;
        }
        if (Buffer.byteLength(JSON.stringify(x)) > 30000) {
          for (const field of Object.keys(x))
            if (
              x[field] &&
              typeof x[field] === "object" &&
              !Array.isArray(x[field]) &&
              !(x[field] instanceof Date)
            )
              x[field] = {
                omitted: true,
                reason:
                  "Large historical data is retained in the private import archive and backup.",
              };
          x.truncated = true;
        }
        const size = Buffer.byteLength(JSON.stringify(x));
        if (bytes + size > 32768 && selected.length) break;
        selected.push(x);
        bytes += size;
      }
      return {
        items: selected,
        has_more: rows.length > selected.length,
        next_cursor: selected.at(-1)?.id || after,
      };
    });
  }
  async identity(p) {
    return transaction(this.pool, async (c) => {
      await this.assertPrincipal(c, p);
      const grants = (await list(c, "agent_repo_grants")).filter(
        (g) =>
          g.agent_id === p.id &&
          (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
      );
      return {
        agent_id: p.id,
        grants: grants.map((g) => ({
          repo_id: g.repo_id,
          project_id: g.project_id,
          body: {
            permissions: g.permissions,
            expires_at: g.expires_at || null,
          },
        })),
        capabilities: {
          start: false,
          pause: false,
          resume: false,
          cancel: false,
          advisory_reservations: true,
        },
      };
    });
  }
  async resource(p, kind, id) {
    const result = await this.read(p, kind, { id, full: true, limit: 1 });
    return result.items[0] || fail(404, "Unknown or unauthorized resource");
  }
  async notifications(p, after = 0) {
    if (!p.owner) fail(403, "Owner only");
    return (
      await this.pool.query(
        "SELECT a.*,r.read_at FROM audit_events a LEFT JOIN notification_receipts r ON r.event_id=a.id AND r.user_id=$1 WHERE a.id>$2 ORDER BY a.id LIMIT 100",
        [p.id, after],
      )
    ).rows;
  }
  async markRead(p, eventId) {
    if (!p.owner) fail(403, "Owner only");
    if (!Number.isSafeInteger(eventId) || eventId < 1)
      fail(400, "Invalid event ID");
    const result = await this.pool.query(
      "INSERT INTO notification_receipts(event_id,user_id) SELECT id,$1 FROM audit_events WHERE id=$2 ON CONFLICT DO NOTHING",
      [p.id, eventId],
    );
    if (
      !result.rowCount &&
      !(
        await this.pool.query("SELECT 1 FROM audit_events WHERE id=$1", [
          eventId,
        ])
      ).rowCount
    )
      fail(404, "Unknown notification");
    return { read: true };
  }
  async events(p, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0)
      fail(400, "Invalid event cursor");
    return transaction(this.pool, async (c) => {
      await this.assertPrincipal(c, p);
      const high = Number(
        (await c.query("SELECT COALESCE(max(id),0) AS id FROM audit_events"))
          .rows[0].id,
      );
      if (after > high)
        fail(
          409,
          "Event cursor is ahead of this database; resync from cursor 0",
        );
      if (p.owner)
        return (
          await c.query(
            "SELECT * FROM audit_events WHERE id>$1 ORDER BY id LIMIT 100",
            [after],
          )
        ).rows;
      const grants = (await list(c, "agent_repo_grants")).filter(
        (g) =>
          g.agent_id === p.id &&
          g.permissions.includes("task:read") &&
          (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
      );
      return (
        await c.query(
          "SELECT * FROM audit_events WHERE id>$1 AND ((recipient_agent_id IS NULL AND (actor=$2 OR repo_id=ANY($3))) OR (recipient_agent_id::text=$2 AND repo_id=ANY($4))) ORDER BY id LIMIT 100",
          [
            after,
            p.id,
            grants.map((g) => g.repo_id),
            (await list(c, "agent_repo_grants"))
              .filter(
                (g) =>
                  g.agent_id === p.id &&
                  g.permissions.includes("cross_repo:request") &&
                  (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
              )
              .map((g) => g.repo_id),
          ],
        )
      ).rows;
    });
  }
  async execute(p, action, input, key) {
    if (!schemas[action]) fail(404, "Unknown action");
    const x = schemas[action].strict().parse(input);
    rejectSecrets(x);
    return transaction(this.pool, async (c) => {
      await this.assertPrincipal(c, p);
      const requestHash = hash(canonical(x));
      const authorizationHash = hash(
        canonical(
          p.owner
            ? { owner: true }
            : (await list(c, "agent_repo_grants")).filter(
                (g) =>
                  g.agent_id === p.id &&
                  (!g.expires_at || Date.parse(g.expires_at) > Date.now()),
              ),
        ),
      );
      if (key) {
        z.string().min(1).max(128).parse(key);
        if (action === "agent_enroll" || action === "agent_rotate")
          fail(
            400,
            "Token issuance cannot be replayed; credentials are shown once",
          );
        const old = (
          await c.query(
            "SELECT result,request_hash,authorization_hash FROM idempotency WHERE actor=$1 AND key=$2",
            [p.id, action + ":" + key],
          )
        ).rows[0];
        if (old) {
          if (old.request_hash !== requestHash)
            fail(409, "Idempotency key reused with a different payload");
          if (old.authorization_hash !== authorizationHash)
            fail(409, "Authorization changed since this retry; use a new key");
          return old.result;
        }
      }
      const owner = () => {
        if (!p.owner) fail(403, "Owner only");
      };
      const need = async (table, id) =>
        (await get(c, table, id)) || fail(404, "Unknown " + table);
      const save = (table, data) =>
        put(c, table, { id: randomUUID(), ...data });
      let r;
      if (action === "project_create") {
        owner();
        r = await save("projects", { ...x, status: "active" });
      }
      if (action === "repo_create") {
        owner();
        await need("projects", x.project_id);
        r = await save("repositories", { ...x, status: "active" });
      }
      if (action === "record_update") {
        owner();
        const old = await need(x.kind, x.id);
        if (old.version !== x.version) fail(409, "Stale version");
        if (
          x.kind === "projects" &&
          [x.reference, x.default_branch, x.case_sensitive].some(
            (v) => v !== undefined,
          )
        )
          fail(400, "Repository metadata cannot be applied to a project");
        if (
          x.case_sensitive !== undefined &&
          x.case_sensitive !== old.case_sensitive &&
          (await list(c, "file_reservations")).some(
            (l) =>
              l.repo_id === old.id &&
              l.state === "active" &&
              Date.parse(l.expires_at) > Date.now(),
          )
        )
          fail(
            409,
            "Release active reservations before changing path matching",
          );
        r = await put(c, x.kind, { ...old, ...x });
      }
      if (action === "agent_enroll") {
        owner();
        const previous = x.existing_id
          ? await need("agents", x.existing_id)
          : null;
        if (previous && (!previous.untrusted || !previous.revoked))
          fail(409, "Only inactive imported identities can be re-enrolled");
        const a = await put(c, "agents", {
          ...(previous || {}),
          id: previous?.id || randomUUID(),
          name: x.name,
          runtime: "external-mcp",
          revoked: false,
          untrusted: false,
        });
        for (const g of x.grants) {
          const repo = await need("repositories", g.repo_id);
          await save("agent_repo_grants", {
            agent_id: a.id,
            repo_id: g.repo_id,
            project_id: repo.project_id,
            permissions: g.permissions,
          });
        }
        const raw = token();
        const t = await save("agent_tokens", {
          agent_id: a.id,
          hash: hash(raw),
          prefix: raw.slice(0, 6),
          expires_at: new Date(
            Date.now() + x.expires_hours * 3600000,
          ).toISOString(),
          revoked: false,
        });
        r = { agent: a, token: raw, token_id: t.id };
      }
      if (action === "token_revoke") {
        owner();
        const t = await need("agent_tokens", x.id);
        r = await put(c, "agent_tokens", { ...t, revoked: true });
        delete r.hash;
      }
      if (action === "agent_rotate") {
        owner();
        const a = await need("agents", x.id);
        if (a.revoked) fail(409, "Enroll a new identity for a revoked agent");
        for (const t of (await list(c, "agent_tokens")).filter(
          (t) => t.agent_id === a.id,
        ))
          await put(c, "agent_tokens", { ...t, revoked: true });
        const raw = token();
        const t = await save("agent_tokens", {
          agent_id: a.id,
          hash: hash(raw),
          prefix: raw.slice(0, 6),
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          revoked: false,
        });
        r = { token: raw, token_id: t.id, agent_id: a.id };
      }
      if (action === "agent_revoke") {
        owner();
        const a = await need("agents", x.id);
        r = await put(c, "agents", { ...a, revoked: true });
        for (const credential of (await list(c, "agent_tokens")).filter(
          (t) => t.agent_id === a.id,
        ))
          await put(c, "agent_tokens", { ...credential, revoked: true });
        for (const lease of (await list(c, "file_reservations")).filter(
          (l) => l.agent_id === a.id && l.state === "active",
        ))
          await put(c, "file_reservations", { ...lease, state: "released" });
        for (const task of (await list(c, "tasks")).filter(
          (t) =>
            t.claimed_by === a.id && !["done", "cancelled"].includes(t.state),
        )) {
          await put(c, "tasks", {
            ...task,
            state: "blocked",
            block_reason: "Assigned agent revoked",
          });
          await save("task_events", {
            repo_id: task.repo_id,
            task_id: task.id,
            action: "agent_revoked",
            state: "blocked",
            comment: "Assigned agent revoked by the operator",
          });
        }
      }
      if (action === "grant_set") {
        owner();
        if ((await need("agents", x.agent_id)).revoked)
          fail(409, "Enroll the inactive agent before granting access");
        const repo = await need("repositories", x.repo_id);
        const old = (await list(c, "agent_repo_grants")).find(
          (g) => g.agent_id === x.agent_id && g.repo_id === x.repo_id,
        );
        r = await put(c, "agent_repo_grants", {
          ...old,
          id: old?.id || randomUUID(),
          project_id: repo.project_id,
          ...x,
        });
      }
      if (action === "task_create") {
        owner();
        const repo = await need("repositories", x.repo_id);
        if (
          repo.status === "archived" ||
          (await need("projects", repo.project_id)).status === "archived"
        )
          fail(409, "Repository or project is archived");
        if (x.assignee) {
          if ((await need("agents", x.assignee)).revoked)
            fail(409, "Assignee is revoked");
          await this.authorize(c, { id: x.assignee }, x.repo_id, "task:claim");
        }
        r = await save("tasks", {
          ...x,
          project_id: repo.project_id,
          state: "ready",
          progress: 0,
          claimed_by: null,
        });
      }
      if (action === "task_comment") {
        const task = await need("tasks", x.id);
        await this.authorize(c, p, task.repo_id, "task:comment");
        r = await save("task_events", {
          repo_id: task.repo_id,
          task_id: task.id,
          agent_id: p.owner ? null : p.id,
          action: "comment",
          comment: x.comment,
        });
      }
      if (action === "dependency_remove") {
        owner();
        const edge = await need("task_dependencies", x.id);
        await c.query("DELETE FROM task_dependencies WHERE id=$1", [edge.id]);
        r = edge;
      }
      if (action === "task_handoff") {
        const task = await need("tasks", x.id);
        await this.authorize(c, p, task.repo_id, "task:update");
        if (task.version !== x.version) fail(409, "Stale task version");
        if (!p.owner && task.claimed_by !== p.id)
          fail(403, "Only the claimant may hand off work");
        if (["done", "cancelled"].includes(task.state))
          fail(409, "Task is closed");
        await this.authorize(c, { id: x.to_agent }, task.repo_id, "task:claim");
        const target = await need("agents", x.to_agent);
        if (target.revoked) fail(409, "Target agent revoked");
        r = await put(c, "tasks", {
          ...task,
          assignee: x.to_agent,
          claimed_by: null,
          state: "ready",
        });
        for (const l of (await list(c, "file_reservations")).filter(
          (l) => l.task_id === task.id && l.state === "active",
        ))
          await put(c, "file_reservations", { ...l, state: "released" });
        await save("task_events", {
          repo_id: task.repo_id,
          task_id: task.id,
          agent_id: p.owner ? null : p.id,
          action: "handoff",
          to_agent: x.to_agent,
          comment: x.reason,
        });
      }
      if (["task_claim", "task_update", "dependency_add"].includes(action)) {
        const t = await need("tasks", x.id);
        await this.authorize(
          c,
          p,
          t.repo_id,
          action === "task_claim" ? "task:claim" : "task:update",
        );
        if (action === "dependency_add") {
          owner();
          const d = await need("tasks", x.depends_on);
          if (d.project_id !== t.project_id)
            fail(400, "Dependencies must be in the same project");
          const edges = await list(c, "task_dependencies");
          const visit = (id, seen = new Set()) => {
            if (id === t.id) return true;
            if (seen.has(id)) return false;
            seen.add(id);
            return edges
              .filter((e) => e.task_id === id)
              .some((e) => visit(e.depends_on, seen));
          };
          if (visit(d.id)) fail(409, "Dependency cycle");
          r = await save("task_dependencies", {
            repo_id: t.repo_id,
            task_id: t.id,
            depends_on: d.id,
          });
        } else {
          if (!p.owner && t.assignee && t.assignee !== p.id)
            fail(403, "Task assigned to another agent");
          if (!p.owner && t.claimed_by && t.claimed_by !== p.id)
            fail(403, "Task claimed by another agent");
          if (action === "task_claim") {
            for (const dep of (await list(c, "task_dependencies")).filter(
              (d) => d.task_id === t.id,
            ))
              if ((await need("tasks", dep.depends_on)).state !== "done")
                fail(409, "Incomplete dependency");
            if (t.claimed_by || !["ready", "backlog"].includes(t.state))
              fail(409, "Task already claimed or unavailable");
            r = await put(c, "tasks", {
              ...t,
              claimed_by: p.id,
              state: "in_progress",
            });
          } else {
            if (
              [x.title, x.description, x.priority, x.due_at].some(
                (v) => v !== undefined,
              )
            )
              owner();
            if (!p.owner && t.claimed_by !== p.id)
              fail(403, "Claim the task before updating it");
            if (["done", "cancelled"].includes(t.state))
              fail(409, "Task is closed");
            if (t.version !== x.version) fail(409, "Stale task version");
            if (x.assignee) {
              owner();
              if (t.claimed_by && t.claimed_by !== x.assignee)
                fail(409, "Use a handoff to change an active claimant");
              await this.authorize(
                c,
                { id: x.assignee },
                t.repo_id,
                "task:claim",
              );
            }
            const transitions = {
              backlog: ["ready", "cancelled"],
              ready: ["in_progress", "blocked", "cancelled"],
              in_progress: ["blocked", "review", "cancelled"],
              blocked: ["ready", "in_progress", "cancelled"],
              review: ["done", "in_progress", "blocked", "cancelled"],
              done: [],
              cancelled: [],
            };
            if (
              x.state &&
              x.state !== t.state &&
              !transitions[t.state].includes(x.state)
            )
              fail(409, "Invalid task transition");
            if (["in_progress", "review", "done"].includes(x.state)) {
              if (x.state === "in_progress" && !t.claimed_by)
                fail(409, "Use task_claim to start work");
              for (const dep of (await list(c, "task_dependencies")).filter(
                (d) => d.task_id === t.id,
              )) {
                if ((await need("tasks", dep.depends_on)).state !== "done")
                  fail(409, "Incomplete dependency");
              }
            }
            r = await put(c, "tasks", {
              ...t,
              ...x,
              ...(x.state === "done" ? { progress: 100 } : {}),
            });
          }
          await save("task_events", {
            repo_id: t.repo_id,
            task_id: t.id,
            agent_id: p.owner ? null : p.id,
            action,
            state: r.state,
            progress: r.progress,
            comment: x.comment || null,
          });
          if (["done", "cancelled"].includes(r.state))
            for (const lease of (await list(c, "file_reservations")).filter(
              (l) => l.task_id === t.id && l.state === "active",
            ))
              await put(c, "file_reservations", {
                ...lease,
                state: "released",
              });
        }
      }
      if (action === "reservation_acquire") {
        await c.query(
          "UPDATE file_reservations SET body=jsonb_set(body,'{state}','\"expired\"') WHERE body->>'state'='active' AND (body->>'expires_at')::timestamptz<=now()",
        );
        await this.authorize(c, p, x.repo_id, "reservation:acquire");
        const repo = await need("repositories", x.repo_id),
          t = await need("tasks", x.task_id);
        if (
          t.repo_id !== x.repo_id ||
          t.claimed_by !== p.id ||
          t.state !== "in_progress"
        )
          fail(403, "Claim the active task first");
        const normalized = normalizePath(x.path, repo.case_sensitive);
        for (const l of await list(c, "file_reservations"))
          if (
            l.repo_id === x.repo_id &&
            l.state === "active" &&
            Date.parse(l.expires_at) > Date.now() &&
            (l.normalized === normalized ||
              l.normalized.startsWith(normalized + "/") ||
              normalized.startsWith(l.normalized + "/"))
          )
            fail(409, "Path reserved");
        r = await save("file_reservations", {
          ...x,
          normalized,
          agent_id: p.id,
          state: "active",
          expires_at: new Date(Date.now() + x.seconds * 1000).toISOString(),
          advisory: true,
        });
      }
      if (action === "reservation_release") {
        const l = await need("file_reservations", x.id);
        await this.authorize(c, p, l.repo_id, "reservation:release");
        if (!p.owner && l.agent_id !== p.id) fail(403, "Not your reservation");
        r = await put(c, "file_reservations", { ...l, state: "released" });
      }
      if (action === "request_create") {
        for (const p of x.requested_paths || []) normalizePath(p);
        await this.authorize(c, p, x.repo_id, "cross_repo:request");
        await need("repositories", x.repo_id);
        const source = await need("repositories", x.repo_id);
        const target = await need("repositories", x.target_repo);
        if (source.project_id !== target.project_id)
          fail(403, "Cross-repo requests must stay inside one project");
        if (x.task_id && (await need("tasks", x.task_id)).repo_id !== x.repo_id)
          fail(400, "Linked task must belong to the source repo");
        if (x.repo_id === x.target_repo)
          fail(400, "Use different repositories");
        r = await save("cross_repo_requests", {
          ...x,
          requester: p.id,
          state: "pending",
          history: [
            {
              state: "pending",
              actor: p.id,
              reason: x.reason,
              timestamp: new Date().toISOString(),
            },
          ],
          expires_at: new Date(Date.now() + x.hours * 3600000).toISOString(),
        });
      }
      if (action === "request_clarify") {
        const q = await need("cross_repo_requests", x.id);
        if (q.requester !== p.id && !p.owner)
          fail(403, "Only the requester may clarify");
        await this.authorize(c, p, q.repo_id, "cross_repo:request");
        if (
          !["pending", "needs-input"].includes(q.state) ||
          Date.parse(q.expires_at) <= Date.now()
        )
          fail(409, "This request cannot be clarified");
        if ((q.history || []).length >= 50)
          fail(409, "Start a new request after 50 transitions");
        r = await put(c, "cross_repo_requests", {
          ...q,
          scope: x.scope || q.scope,
          state: "pending",
          approver: null,
          history: [
            ...(q.history || []),
            {
              state: "pending",
              actor: p.id,
              reason: x.clarification,
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
      if (["request_decide", "request_answer"].includes(action)) {
        const q = await need("cross_repo_requests", x.id);
        await this.authorize(
          c,
          p,
          action === "request_decide" &&
            x.decision === "revoked" &&
            q.requester === p.id
            ? q.repo_id
            : q.target_repo,
          action === "request_decide" &&
            x.decision === "revoked" &&
            q.requester === p.id
            ? "cross_repo:request"
            : "cross_repo:approve",
        );
        if ((q.history || []).length >= 50)
          fail(409, "Start a new request after 50 transitions");
        if (Date.parse(q.expires_at) <= Date.now())
          fail(409, "Request expired");
        if (action === "request_decide") {
          if (["answered", "revoked", "denied"].includes(q.state))
            fail(409, "Request closed");
          r = await put(c, "cross_repo_requests", {
            ...q,
            state: x.decision,
            decision_reason: x.reason,
            approver: p.id,
            history: [
              ...(q.history || []),
              {
                state: x.decision,
                actor: p.id,
                reason: x.reason,
                timestamp: new Date().toISOString(),
              },
            ],
          });
        } else {
          if (q.state !== "approved")
            fail(409, "Approve this precise scope before answering");
          if (x.reference) {
            normalizePath(x.reference.path);
            if (
              q.requested_paths?.length &&
              !q.requested_paths.includes(x.reference.path)
            )
              fail(403, "Response path is outside the approved request");
          }
          r = await save("cross_repo_responses", {
            repo_id: q.target_repo,
            request_id: q.id,
            content: x.content,
            reference: x.reference || null,
            responder: p.id,
            scope: q.scope,
          });
          await put(c, "cross_repo_requests", {
            ...q,
            state: "answered",
            history: [
              ...(q.history || []),
              {
                state: "answered",
                actor: p.id,
                timestamp: new Date().toISOString(),
              },
            ],
          });
          if (await get(c, "agents", q.requester))
            await this.audit(
              c,
              p,
              "cross_repo_answer_ready",
              q.id,
              q.repo_id,
              { request_id: q.id },
              q.requester,
            );
        }
      }
      if (action === "context_publish") {
        await this.authorize(c, p, x.repo_id, "context:publish");
        if (!p.owner && x.permitted_repos.some((repo) => repo !== x.repo_id))
          fail(403, "Only owner may grant cross-repo context sharing");
        for (const repo of x.permitted_repos) await need("repositories", repo);
        const old = (await list(c, "shared_context_items")).filter(
          (i) => i.repo_id === x.repo_id && i.key === x.key,
        );
        const nextVersion =
          old.reduce(
            (max, item) => Math.max(max, Number(item.context_version) || 0),
            0,
          ) + 1;
        if (nextVersion > 2147483647)
          fail(
            409,
            "Context version range exhausted; publish under a new reviewed key",
          );
        r = await save("shared_context_items", {
          ...x,
          agent_id: p.owner ? null : p.id,
          context_version: nextVersion,
        });
      }
      if (!r) fail(400, "Unsupported operation");
      if (Buffer.byteLength(JSON.stringify(r)) > 24576)
        fail(
          400,
          "Entry exceeds 24 KiB; reduce the payload or start a new request for a long decision history",
        );
      await this.audit(
        c,
        p,
        action,
        r.id || r.agent?.id || null,
        r.repo_id || null,
        {
          version: r.version || 1,
          ...(r.state ? { state: r.state } : {}),
          ...(x.permissions ? { permissions: x.permissions } : {}),
          ...(x.target_repo ? { target_repo: x.target_repo } : {}),
          ...(x.decision ? { decision: x.decision } : {}),
        },
      );
      if (key)
        await c.query(
          "INSERT INTO idempotency(actor,key,result,request_hash,authorization_hash) VALUES($1,$2,$3,$4,$5)",
          [p.id, action + ":" + key, r, requestHash, authorizationHash],
        );
      return r;
    }).catch(async (error) => {
      if (error.statusCode === 403)
        await transaction(this.pool, (c) =>
          this.audit(c, p, "authorization_denied", null, null, {
            action,
            outcome: "denied",
          }),
        ).catch(() => {});
      throw error;
    });
  }
}
