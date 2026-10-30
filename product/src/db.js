import pg from "pg";
export const SCHEMA_VERSION = 10;
export const tables = [
  "projects",
  "repositories",
  "agents",
  "agent_tokens",
  "agent_repo_grants",
  "tasks",
  "task_dependencies",
  "task_events",
  "file_reservations",
  "shared_context_items",
  "cross_repo_requests",
  "cross_repo_responses",
  "runtime_jobs",
  "imports",
  "messages",
  "legacy_approvals",
  "legacy_audit",
  "handoffs",
  "import_plans",
];
export async function database(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Set DATABASE_URL to a PostgreSQL connection URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.password ||
    /replace_with|changeme|^(?:password|postgres|example)$/i.test(
      decodeURIComponent(parsed.password),
    )
  )
    throw new Error(
      "DATABASE_URL requires a non-placeholder PostgreSQL password",
    );
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  pool.on("error", () => {
    /* Discarded idle clients reconnect on the next query. */
  });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw new Error(
      "PostgreSQL connection unavailable; verify the configured database and credentials",
    );
  }
  const c = await pool.connect();
  let migrationError;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(431001)");
    await c.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz DEFAULT now());`,
    );
    const { rows } = await c.query(
      "SELECT max(version) AS v FROM schema_migrations",
    );
    if (Number(rows[0].v) > SCHEMA_VERSION)
      throw Error("Unsupported newer schema");
    if (!rows[0].v) {
      await c.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL);
 CREATE TABLE sessions(hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),csrf text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE audit_events(id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,resource_id text,repo_id text,request_id text,metadata jsonb NOT NULL DEFAULT '{}',timestamp timestamptz NOT NULL DEFAULT now());
 CREATE TABLE outbox_events(id bigint PRIMARY KEY REFERENCES audit_events(id), delivered_at timestamptz);
 CREATE TABLE idempotency(actor text,key text,result jsonb,PRIMARY KEY(actor,key));`);
      for (const table of tables)
        await c.query(
          `CREATE TABLE ${table}(id uuid PRIMARY KEY,project_id uuid,repo_id uuid,agent_id uuid,body jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX ${table}_repo ON ${table}(repo_id);`,
        );
      await c.query(
        `CREATE UNIQUE INDEX unique_grant ON agent_repo_grants(agent_id,repo_id);CREATE UNIQUE INDEX unique_token_hash ON agent_tokens((body->>'hash'));CREATE UNIQUE INDEX unique_dependency ON task_dependencies((body->>'task_id'),(body->>'depends_on'));INSERT INTO schema_migrations(version) VALUES(1)`,
      );
    }
    if (Number(rows[0].v) < 2) {
      for (const table of tables) {
        await c.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${table}_project_fk FOREIGN KEY(project_id) REFERENCES projects(id);ALTER TABLE ${table} ADD CONSTRAINT ${table}_repo_fk FOREIGN KEY(repo_id) REFERENCES repositories(id);ALTER TABLE ${table} ADD CONSTRAINT ${table}_agent_fk FOREIGN KEY(agent_id) REFERENCES agents(id)`,
        );
      }
      await c.query(`CREATE UNIQUE INDEX active_exact_path ON file_reservations(repo_id,(body->>'normalized')) WHERE body->>'state'='active';
 CREATE FUNCTION deny_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are append-only'; END $$;
 CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
 INSERT INTO schema_migrations(version) VALUES(2)`);
    }
    if (Number(rows[0].v) < 3) {
      await c.query(`ALTER TABLE idempotency ADD COLUMN request_hash text;ALTER TABLE idempotency ADD COLUMN authorization_hash text;
 CREATE TABLE notification_receipts(event_id bigint NOT NULL REFERENCES audit_events(id), user_id uuid NOT NULL REFERENCES users(id),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(event_id,user_id));
 INSERT INTO schema_migrations(version) VALUES(3)`);
    }
    if (Number(rows[0].v) < 4) {
      await c.query(`
 ALTER TABLE tasks ADD CONSTRAINT task_state CHECK(body->>'state' IN ('backlog','ready','in_progress','blocked','review','done','cancelled'));
 ALTER TABLE tasks ADD CONSTRAINT task_progress CHECK((body->>'progress')::integer BETWEEN 0 AND 100);
 ALTER TABLE tasks ADD CONSTRAINT task_priority CHECK((body->>'priority')::integer BETWEEN 1 AND 5);
 ALTER TABLE tasks ADD COLUMN assignee_id uuid GENERATED ALWAYS AS ((body->>'assignee')::uuid) STORED REFERENCES agents(id);
 ALTER TABLE task_dependencies ADD COLUMN task_id uuid GENERATED ALWAYS AS ((body->>'task_id')::uuid) STORED REFERENCES tasks(id);
 ALTER TABLE task_dependencies ADD COLUMN depends_on_id uuid GENERATED ALWAYS AS ((body->>'depends_on')::uuid) STORED REFERENCES tasks(id);
 ALTER TABLE task_dependencies ADD CONSTRAINT no_self_dependency CHECK(task_id<>depends_on_id);
 ALTER TABLE file_reservations ADD COLUMN task_id uuid GENERATED ALWAYS AS ((body->>'task_id')::uuid) STORED REFERENCES tasks(id);
 ALTER TABLE cross_repo_requests ADD COLUMN target_repo_id uuid GENERATED ALWAYS AS ((body->>'target_repo')::uuid) STORED REFERENCES repositories(id);
 ALTER TABLE cross_repo_responses ADD COLUMN request_id uuid GENERATED ALWAYS AS ((body->>'request_id')::uuid) STORED REFERENCES cross_repo_requests(id);
 INSERT INTO schema_migrations(version) VALUES(4)`);
    }
    if (Number(rows[0].v) < 5) {
      for (const table of [
        "messages",
        "legacy_approvals",
        "legacy_audit",
        "handoffs",
        "import_plans",
      ]) {
        await c.query(
          `CREATE TABLE IF NOT EXISTS ${table}(id uuid PRIMARY KEY,project_id uuid REFERENCES projects(id),repo_id uuid REFERENCES repositories(id),agent_id uuid REFERENCES agents(id),body jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());CREATE INDEX IF NOT EXISTS ${table}_repo ON ${table}(repo_id)`,
        );
      }
      await c.query("INSERT INTO schema_migrations(version) VALUES(5)");
    }
    if (Number(rows[0].v) < 6) {
      await c.query(`ALTER TABLE audit_events ADD COLUMN recipient_agent_id uuid REFERENCES agents(id);
 ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();ALTER TABLE sessions ADD CONSTRAINT session_id_unique UNIQUE(id);
 ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();ALTER TABLE sessions ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
 INSERT INTO schema_migrations(version) VALUES(6)`);
    }
    if (Number(rows[0].v) < 7) {
      await c.query(`
 ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled'));
 ALTER TABLE users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
 ALTER TABLE tasks ADD CONSTRAINT required_task_fields CHECK(body ?& ARRAY['title','state','progress','priority'] AND jsonb_typeof(body->'title')='string');
 ALTER TABLE agent_repo_grants ADD CONSTRAINT grant_permissions CHECK(jsonb_typeof(body->'permissions')='array' AND body->'permissions' <@ '["task:read","task:claim","task:update","task:comment","reservation:acquire","reservation:release","context:read","context:publish","cross_repo:request","cross_repo:approve"]'::jsonb);
 ALTER TABLE agent_tokens ADD CONSTRAINT hashed_token_only CHECK(body->>'hash' ~ '^[a-f0-9]{64}$' AND NOT body ? 'token');
 ALTER TABLE shared_context_items ADD CONSTRAINT context_fields CHECK(body ?& ARRAY['key','content','permitted_repos'] AND jsonb_typeof(body->'permitted_repos')='array');
 CREATE TRIGGER immutable_task_events BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
 CREATE TRIGGER immutable_context BEFORE UPDATE OR DELETE ON shared_context_items FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
 INSERT INTO schema_migrations(version) VALUES(7)`);
    }
    if (Number(rows[0].v) < 8) {
      await c.query(`CREATE UNIQUE INDEX context_key_version ON shared_context_items(repo_id,(body->>'key'),((body->>'context_version')::integer));
        ALTER TABLE shared_context_items ADD CONSTRAINT positive_context_version CHECK(body ? 'context_version' AND (body->>'context_version')::integer>=1);
        INSERT INTO schema_migrations(version) VALUES(8)`);
    }
    if (Number(rows[0].v) < 9) {
      await c.query(`ALTER TABLE runtime_jobs ADD COLUMN task_id uuid GENERATED ALWAYS AS ((body->>'task_id')::uuid) STORED REFERENCES tasks(id);
        CREATE UNIQUE INDEX active_runtime_task ON runtime_jobs(task_id) WHERE body->>'state' IN ('preparing','running','paused');
        ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_state CHECK(body->>'state' IN ('preparing','running','paused','exited','cancelled','failed'));
        INSERT INTO schema_migrations(version) VALUES(9)`);
    }
    if (Number(rows[0].v) < 10) {
      await c.query(`ALTER TABLE agent_repo_grants DROP CONSTRAINT grant_permissions;
      ALTER TABLE agent_repo_grants ADD CONSTRAINT grant_permissions CHECK(jsonb_typeof(body->'permissions')='array' AND body->'permissions' <@ '["task:read","task:create","task:claim","task:update","task:comment","reservation:acquire","reservation:release","context:read","context:publish","cross_repo:request","cross_repo:approve"]'::jsonb);
      INSERT INTO schema_migrations(version) VALUES(10)`);
    }
    await c.query("COMMIT");
  } catch (e) {
    migrationError = e;
    await c.query("ROLLBACK").catch(() => {});
  } finally {
    c.release();
  }
  if (migrationError) {
    await pool.end();
    throw migrationError;
  }
  return pool;
}
export async function transaction(pool, fn, options) {
  const c = await pool.connect();
  try {
    return await connectionTransaction(c, fn, options);
  } finally {
    c.release();
  }
}
export async function connectionTransaction(c, fn, { readOnly = false } = {}) {
  try {
    await c.query(
      readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
    );
    if (!readOnly) await c.query("SELECT pg_advisory_xact_lock(431002)");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
export function hydrate(r) {
  return r
    ? {
        ...r.body,
        id: r.id,
        project_id: r.project_id,
        repo_id: r.repo_id,
        agent_id: r.agent_id,
        version: r.version,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }
    : null;
}
export async function get(c, table, id) {
  if (!tables.includes(table)) throw Error("Invalid table");
  return hydrate(
    (await c.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0],
  );
}
export async function list(c, table) {
  if (!tables.includes(table)) throw Error("Invalid table");
  return (
    await c.query(`SELECT * FROM ${table} ORDER BY created_at,id`)
  ).rows.map(hydrate);
}
export async function put(c, table, x) {
  if (!tables.includes(table)) throw Error("Invalid table");
  const {
    id,
    project_id = null,
    repo_id = null,
    agent_id = null,
    version,
    created_at,
    updated_at,
    ...body
  } = x;
  return hydrate(
    (
      await c.query(
        `INSERT INTO ${table}(id,project_id,repo_id,agent_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET body=excluded.body,project_id=excluded.project_id,repo_id=excluded.repo_id,agent_id=excluded.agent_id,version=${table}.version+1,updated_at=now() RETURNING *`,
        [id, project_id, repo_id, agent_id, body],
      )
    ).rows[0],
  );
}
