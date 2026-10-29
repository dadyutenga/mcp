import Database from "better-sqlite3";
import {
  mkdirSync,
  readFileSync,
  chmodSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { database, transaction, get } from "./db.js";
import { normalizePath } from "./service.js";
import { rejectSecrets } from "../../tools/agent-coordination/src/workspace.js";
const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const mapped = (source, kind, id) => {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(id),
    )
  )
    return id;
  const h = digest(source + ":" + kind + ":" + id);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const legacyTables = [
  "agents",
  "tasks",
  "task_dependencies",
  "messages",
  "change_requests",
  "audit_events",
  "file_reservations",
  "file_conflicts",
  "ownership_requests",
];
const historical = {
  messages: "messages",
  change_requests: "legacy_approvals",
  ownership_requests: "legacy_approvals",
  audit_events: "legacy_audit",
  file_conflicts: "task_events",
};
export function discoverLegacy(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", ".git", "dist"].includes(entry.name)
      )
        visit(target);
      else if (entry.isFile() && /\.(?:sqlite|sqlite3|db)$/.test(entry.name)) {
        const db = new Database(target, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          found.push({
            path: target,
            version: db.pragma("user_version", { simple: true }),
            bytes: statSync(target).size,
          });
        } finally {
          db.close();
        }
      }
    }
  };
  visit(root);
  return found;
}
export async function inspectImport(source, backupDir, sourceId) {
  if (!sourceId || sourceId.length > 100)
    throw Error("A stable source-id label is required");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  const backup = path.join(backupDir, randomUUID() + ".sqlite");
  try {
    await db.backup(backup);
    chmodSync(backup, 0o600);
  } finally {
    db.close();
  }
  const copy = new Database(backup, { readonly: true });
  try {
    const version = copy.pragma("user_version", { simple: true });
    const names = copy
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    const workspace = names.includes("workspaces");
    const supported = workspace
      ? ["workspaces", "repos", "events"]
      : legacyTables;
    if (
      version < 1 ||
      version > (workspace ? 1 : 2) ||
      names.some((t) => !supported.includes(t))
    )
      throw Error(
        "Unsupported schema elements; review source before importing",
      );
    const records = {};
    for (const name of names)
      records[name] = copy
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
        .all();
    rejectSecrets(records);
    const issues = [];
    for (const l of records.file_reservations || [])
      try {
        normalizePath(l.repository_path);
      } catch {
        issues.push({
          table: "file_reservations",
          id: l.id,
          error: "Invalid repository path",
        });
      }
    return {
      source_id: sourceId,
      fingerprint: digest(records),
      backup,
      version,
      workspace,
      counts: Object.fromEntries(
        Object.entries(records).map(([k, v]) => [k, v.length]),
      ),
      records,
      issues,
    };
  } finally {
    copy.close();
  }
}
function mappingFor(plan, target) {
  if (typeof target === "string")
    return { default_repo: target, repositories: {}, share_with: {} };
  return {
    default_repo: target?.default_repo,
    repositories: target?.repositories || {},
    share_with: target?.share_with || {},
  };
}
async function buildRows(c, plan, target) {
  const mapping = mappingFor(plan, target),
    issues = [...(plan.issues || [])],
    rows = [],
    repoCache = new Map();
  const resolve = async (key) => {
    const repoId = key ? mapping.repositories[key] : mapping.default_repo;
    if (!repoId) {
      issues.push({
        scope: key || "repo",
        error: "Destination repository mapping is required",
      });
      return null;
    }
    if (!repoCache.has(repoId)) {
      const repo = await get(c, "repositories", repoId);
      if (!repo)
        issues.push({
          scope: key || "repo",
          error: "Unknown destination repository",
          id: repoId,
        });
      repoCache.set(repoId, repo);
    }
    return repoCache.get(repoId);
  };
  const add = (table, record, body, repo, sourceKey) => {
    if (!repo) return;
    const rawId = record.id ?? record.cursor;
    const id = mapped(plan.source_id, sourceKey || table, rawId);
    const timestamp =
      record.created_at || record.timestamp || new Date().toISOString();
    const updated = record.updated_at || record.timestamp || timestamp;
    if (
      !Number.isFinite(Date.parse(timestamp)) ||
      !Number.isFinite(Date.parse(updated))
    ) {
      issues.push({ table, id: rawId, error: "Invalid timestamp" });
      return;
    }
    rows.push({
      table,
      id,
      repo,
      body: { ...body, legacy_source: plan.source_id, legacy_id: rawId },
      created_at: timestamp,
      updated_at: updated,
    });
  };
  if (!plan.workspace) {
    const repo = await resolve();
    for (const a of plan.records.agents || [])
      add(
        "agents",
        a,
        {
          name: a.display_name,
          revoked: true,
          untrusted: true,
          runtime: "legacy-import",
          legacy_role: a.role,
        },
        repo,
      );
    for (const t of plan.records.tasks || [])
      add(
        "tasks",
        t,
        {
          title: t.title,
          description: t.description,
          state:
            {
              open: "ready",
              completed: "done",
              cancelled: "cancelled",
              blocked: "blocked",
              in_progress: "blocked",
            }[t.status] || "backlog",
          progress: t.progress,
          claimed_by: null,
          legacy_claimant: t.claimed_by_agent_id,
          priority: t.priority,
        },
        repo,
      );
    for (const d of plan.records.task_dependencies || [])
      add(
        "task_dependencies",
        { ...d, id: d.task_id + ":" + d.depends_on_task_id },
        {
          task_id: mapped(plan.source_id, "tasks", d.task_id),
          depends_on: mapped(plan.source_id, "tasks", d.depends_on_task_id),
        },
        repo,
      );
    for (const l of plan.records.file_reservations || []) {
      let normalized;
      try {
        normalized = normalizePath(l.repository_path, repo?.case_sensitive);
      } catch {
        continue;
      }
      add(
        "file_reservations",
        l,
        {
          path: l.repository_path,
          normalized,
          task_id: mapped(plan.source_id, "tasks", l.task_id),
          state: "expired",
          expires_at: l.expires_at,
          advisory: true,
          legacy_agent_id: l.agent_id,
        },
        repo,
      );
    }
    for (const [name, table] of Object.entries(historical))
      for (const record of plan.records[name] || [])
        add(
          table,
          record,
          {
            legacy_type: name,
            legacy_record: record,
            historical: true,
            state: "historical",
          },
          repo,
          name,
        );
  } else {
    const declared = new Set(
      (plan.records.repos || []).map((r) => r.workspace_id + "/" + r.repo_id),
    );
    for (const key of declared) await resolve(key);
    const identities = new Set();
    for (const e of plan.records.events || []) {
      const scope = e.workspace_id + "/" + e.repo_id,
        identity = scope + "/" + e.agent_id;
      if (declared.has(scope) && e.agent_id && !identities.has(identity)) {
        identities.add(identity);
        add(
          "agents",
          { id: identity, timestamp: e.timestamp },
          {
            name: e.agent_id,
            revoked: true,
            untrusted: true,
            runtime: "legacy-import",
            origin_repo: scope,
          },
          await resolve(scope),
          "workspace-agent",
        );
      }
    }
    for (const e of plan.records.events || []) {
      const key = e.workspace_id + "/" + e.repo_id;
      if (!declared.has(key)) {
        issues.push({
          table: "events",
          id: e.cursor,
          error: "Event source repo was not registered",
        });
        continue;
      }
      const repo = await resolve(key);
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        issues.push({
          table: "events",
          id: e.cursor,
          error: "Invalid event payload",
        });
        continue;
      }
      if (e.kind === "context") {
        const permitted = mapping.share_with[key] || [];
        for (const repoId of permitted)
          if (!(await get(c, "repositories", repoId)))
            issues.push({
              scope: key,
              error: "Unknown sharing destination",
              id: repoId,
            });
        add(
          "shared_context_items",
          e,
          {
            key: data.key,
            content: data.content,
            context_version: e.version,
            permitted_repos: [
              ...new Set([repo?.id, ...permitted].filter(Boolean)),
            ],
            sensitivity: "restricted",
            origin_repo: key,
            legacy_agent_id: e.agent_id,
            type: data.type,
            tags: data.tags || [],
          },
          repo,
          "workspace-context",
        );
      } else if (e.kind === "handoff") {
        const destination = await resolve(e.workspace_id + "/" + data.to_repo);
        add(
          "handoffs",
          e,
          {
            ...data,
            to_repo: destination?.id,
            from_repo: (await resolve(e.workspace_id + "/" + data.from_repo))
              ?.id,
            historical: true,
            legacy_version: e.version,
            legacy_agent_id: e.agent_id,
          },
          repo,
          "workspace-handoff",
        );
      } else
        add(
          "task_events",
          e,
          {
            legacy_type: "workspace-" + e.kind,
            legacy_record: e,
            historical: true,
          },
          repo,
          "workspace-event",
        );
    }
  }
  const seen = new Set();
  for (const row of rows) {
    if (
      ["tasks", "shared_context_items", "agents"].includes(row.table) &&
      Buffer.byteLength(JSON.stringify(row.body)) > 24576
    )
      issues.push({
        table: row.table,
        id: row.id,
        error:
          "Live record exceeds 24 KiB; review and split this record before import",
      });
    const identity = row.table + ":" + row.id;
    if (seen.has(identity))
      issues.push({
        table: row.table,
        id: row.id,
        error: "Duplicate source identity",
      });
    seen.add(identity);
    if (await get(c, row.table, row.id))
      issues.push({
        table: row.table,
        id: row.id,
        error: "Destination ID collision",
      });
  }
  for (const row of rows.filter(
    (r) => r.table === "task_dependencies" || r.table === "file_reservations",
  ))
    for (const ref of ["task_id", "depends_on"])
      if (
        row.body[ref] &&
        !rows.some((r) => r.table === "tasks" && r.id === row.body[ref]) &&
        !(await get(c, "tasks", row.body[ref]))
      )
        issues.push({
          table: row.table,
          id: row.id,
          error: "Missing referenced task",
        });
  const edges = rows.filter((r) => r.table === "task_dependencies");
  for (const edge of edges) {
    const visit = (id, seen = new Set()) => {
      if (id === edge.body.task_id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return edges
        .filter((e) => e.body.task_id === id)
        .some((e) => visit(e.body.depends_on, seen));
    };
    if (visit(edge.body.depends_on))
      issues.push({
        table: "task_dependencies",
        id: edge.id,
        error: "Dependency cycle",
      });
  }
  return { mapping, rows, issues };
}
export async function previewImport(pool, plan, target) {
  return transaction(pool, async (c) => {
    const mapping = mappingFor(plan, target),
      previous = await get(
        c,
        "imports",
        mapped(plan.source_id, "import", "record"),
      );
    if (
      previous?.signature === digest({ fingerprint: plan.fingerprint, mapping })
    )
      return {
        source_id: plan.source_id,
        backup: plan.backup,
        counts: plan.counts,
        issues: [],
        mapping,
        proposed: [],
        already_imported: true,
        warnings: [
          "This exact source and destination mapping are already imported.",
        ],
      };
    const { rows, issues } = await buildRows(c, plan, target);
    return {
      source_id: plan.source_id,
      backup: plan.backup,
      counts: plan.counts,
      issues,
      mapping,
      proposed: rows.map((r) => ({
        table: r.table,
        id: r.id,
        repo_id: r.repo.id,
        legacy_id: r.body.legacy_id,
      })),
      warnings: [
        "Imported identities remain revoked and untrusted.",
        "Leases become historical/expired.",
        "Legacy approvals never become active grants.",
        "Imported context is private to its mapped source repo unless sharing is explicitly selected.",
      ],
    };
  });
}
export async function applyImport(pool, plan, target) {
  return transaction(pool, async (c) => {
    const mapping = mappingFor(plan, target),
      signature = digest({ fingerprint: plan.fingerprint, mapping }),
      importId = mapped(plan.source_id, "import", "record"),
      previous = await get(c, "imports", importId);
    if (previous) {
      if (previous.signature !== signature)
        throw Error(
          "Source or mapping changed since import; use a new explicit source-id after reviewing collisions",
        );
      return { already_imported: true, id: importId, counts: previous.counts };
    }
    const { rows, issues } = await buildRows(c, plan, target);
    if (issues.length)
      throw Error(
        "Import requires review: " + JSON.stringify(issues.slice(0, 20)),
      );
    for (const row of rows)
      await c.query(
        `INSERT INTO ${row.table}(id,project_id,repo_id,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          row.id,
          row.repo.project_id,
          row.repo.id,
          row.body,
          row.created_at,
          row.updated_at,
        ],
      );
    await c.query("INSERT INTO imports(id,repo_id,body) VALUES($1,$2,$3)", [
      importId,
      rows[0]?.repo.id || mapping.default_repo || null,
      {
        source_id: plan.source_id,
        fingerprint: plan.fingerprint,
        signature,
        counts: plan.counts,
        backup: plan.backup,
        mapping,
        records: plan.records,
        mapped_count: rows.length,
      },
    ]);
    const event = (
      await c.query(
        "INSERT INTO audit_events(actor,action,resource_id,metadata) VALUES('operator-cli','legacy_import',$1,$2) RETURNING id",
        [importId, { counts: plan.counts, mapped: rows.length }],
      )
    ).rows[0];
    await c.query("INSERT INTO outbox_events(id) VALUES($1)", [event.id]);
    return { id: importId, mapped: rows.length, counts: plan.counts };
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((x) => x.startsWith("--") && x.includes("="))
      .map((x) => x.slice(2).split(/=(.*)/s).slice(0, 2)),
  );
  if (args.discover) {
    console.log(JSON.stringify(discoverLegacy(args.discover), null, 2));
  } else {
    const plan = await inspectImport(
      args.source,
      args.backups || "backups",
      args["source-id"],
    );
    const target = args.mapping
      ? JSON.parse(readFileSync(args.mapping, "utf8"))
      : args.repo;
    if (!process.env.DATABASE_URL) {
      console.log(
        JSON.stringify(
          {
            source_id: plan.source_id,
            backup: plan.backup,
            counts: plan.counts,
            issues: plan.issues,
            workspace: plan.workspace,
          },
          null,
          2,
        ),
      );
    } else {
      const pool = await database(process.env.DATABASE_URL);
      try {
        console.log(
          JSON.stringify(await previewImport(pool, plan, target), null, 2),
        );
        if (args.apply === "true")
          console.log(await applyImport(pool, plan, target));
      } finally {
        await pool.end();
      }
    }
  }
}
