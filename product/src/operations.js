import { realpathSync, statSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  inspectImport,
  previewImport,
  applyImport,
  discoverLegacy,
} from "./import.js";
import { transaction, get, put } from "./db.js";
import { Fault } from "./service.js";
const mapping = z.object({
  default_repo: z.uuid().optional(),
  repositories: z.record(z.string(), z.uuid()).default({}),
  share_with: z.record(z.string(), z.array(z.uuid())).default({}),
});
export class Operations {
  constructor(
    pool,
    service,
    {
      importRoot = process.env.LEGACY_IMPORT_ROOT,
      backupRoot = process.env.BACKUP_DIR ||
        path.join(os.homedir(), ".local", "share", "coordination", "backups"),
    } = {},
  ) {
    this.pool = pool;
    this.service = service;
    this.importRoot = importRoot;
    this.backupRoot = backupRoot;
  }
  owner(p) {
    if (!p.owner) throw new Fault(403, "Owner only");
  }
  source(input) {
    if (!this.importRoot || !existsSync(this.importRoot))
      throw new Fault(
        409,
        "Configure an existing LEGACY_IMPORT_ROOT before importing",
      );
    const root = realpathSync(this.importRoot),
      target = realpathSync(path.resolve(root, input));
    const relative = path.relative(root, target);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      throw new Fault(
        400,
        "Import source must remain inside the configured import directory",
      );
    if (!statSync(target).isFile())
      throw new Fault(400, "Select a SQLite database file");
    return target;
  }
  async status(p) {
    this.owner(p);
    return {
      import_available: !!this.importRoot && existsSync(this.importRoot),
      import_root: this.importRoot || null,
      backup_count: existsSync(this.backupRoot)
        ? readdirSync(this.backupRoot).filter((n) => /\.sqlite$/.test(n)).length
        : 0,
      backup_directory: this.backupRoot,
      postgres_backup:
        "Use documented pg_dump/restore commands; database files are never served over HTTP.",
    };
  }
  async discover(p) {
    this.owner(p);
    if (!this.importRoot || !existsSync(this.importRoot))
      return { items: [], available: false };
    return {
      items: discoverLegacy(realpathSync(this.importRoot)).map((x) => ({
        ...x,
        path: path.relative(realpathSync(this.importRoot), x.path),
      })),
      available: true,
    };
  }
  async inspect(p, input) {
    this.owner(p);
    const x = z
      .object({
        source: z.string().min(1).max(4096),
        source_id: z.string().min(1).max(100),
      })
      .strict()
      .parse(input);
    const plan = await inspectImport(
      this.source(x.source),
      this.backupRoot,
      x.source_id,
    );
    const id = randomUUID();
    await transaction(this.pool, async (c) => {
      await put(c, "import_plans", {
        id,
        source_id: x.source_id,
        plan,
        state: "inspected",
      });
      await this.service.audit(c, p, "import_inspect", id, null, {
        counts: plan.counts,
      });
    });
    return {
      id,
      source_id: plan.source_id,
      counts: plan.counts,
      issues: plan.issues,
      workspace: plan.workspace,
      repositories: (plan.records.repos || []).map((r) => ({
        key: r.workspace_id + "/" + r.repo_id,
        role: r.role,
        path: r.path,
      })),
      backup_created: true,
    };
  }
  async review(p, id, input) {
    this.owner(p);
    z.uuid().parse(id);
    const target = mapping.parse(input);
    const stored = await get(this.pool, "import_plans", id);
    if (!stored) throw new Fault(404, "Unknown import plan");
    if (stored.state === "applied")
      throw new Fault(409, "Import already applied");
    const preview = await previewImport(this.pool, stored.plan, target);
    await transaction(this.pool, async (c) => {
      await put(c, "import_plans", {
        ...stored,
        mapping: target,
        preview,
        state: "reviewed",
      });
      await this.service.audit(c, p, "import_review", id, null, {
        issues: preview.issues.length,
        mapped: preview.proposed.length,
      });
    });
    return preview;
  }
  async apply(p, id, input) {
    this.owner(p);
    z.uuid().parse(id);
    const confirmation = z
      .object({ confirm: z.literal(true) })
      .strict()
      .parse(input);
    const stored = await get(this.pool, "import_plans", id);
    if (!stored || !stored.mapping || stored.preview?.issues.length)
      throw new Fault(409, "Review a complete mapping with no issues first");
    const result = await applyImport(this.pool, stored.plan, stored.mapping);
    await transaction(this.pool, async (c) => {
      await put(c, "import_plans", { ...stored, state: "applied", result });
      await this.service.audit(c, p, "import_apply", id, null, {
        import_id: result.id,
      });
    });
    return result;
  }
}

export async function diagnose(pool) {
  const { SCHEMA_VERSION } = await import("./db.js");
  const version = Number(
    (await pool.query("SELECT max(version) AS version FROM schema_migrations"))
      .rows[0].version,
  );
  return {
    ready: version === SCHEMA_VERSION,
    schema_version: version,
    expected_schema_version: SCHEMA_VERSION,
    outbox_pending: Number(
      (
        await pool.query(
          "SELECT count(*) FROM outbox_events WHERE delivered_at IS NULL",
        )
      ).rows[0].count,
    ),
    runtime_adapter: "unsupported",
    advisory_reservations: true,
  };
}
if (
  process.argv[1] &&
  import.meta.url === new URL("file://" + process.argv[1]).href &&
  process.argv[2] === "diagnostics"
) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    const report = await diagnose(pool);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({
        ready: false,
        error:
          "Database unavailable or migrations incomplete. No credential values are included.",
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
