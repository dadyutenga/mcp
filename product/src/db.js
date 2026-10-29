import pg from 'pg';
export const tables=['projects','repositories','agents','agent_tokens','agent_repo_grants','tasks','task_dependencies','task_events','file_reservations','shared_context_items','cross_repo_requests','cross_repo_responses','runtime_jobs','imports'];
export async function database(url){
 const pool=new pg.Pool({connectionString:url,max:10});
 await pool.query('SELECT 1');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(431001)');
 await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz DEFAULT now());`);
 const {rows}=await c.query('SELECT max(version) AS v FROM schema_migrations');if(Number(rows[0].v)>2)throw Error('Unsupported newer schema');
 if(!rows[0].v){
 await c.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL);
 CREATE TABLE sessions(hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),csrf text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE audit_events(id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,resource_id text,repo_id text,request_id text,metadata jsonb NOT NULL DEFAULT '{}',timestamp timestamptz NOT NULL DEFAULT now());
 CREATE TABLE outbox_events(id bigint PRIMARY KEY REFERENCES audit_events(id), delivered_at timestamptz);
 CREATE TABLE idempotency(actor text,key text,result jsonb,PRIMARY KEY(actor,key));`);
 for(const table of tables)await c.query(`CREATE TABLE ${table}(id uuid PRIMARY KEY,project_id uuid,repo_id uuid,agent_id uuid,body jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX ${table}_repo ON ${table}(repo_id);`);
 await c.query(`CREATE UNIQUE INDEX unique_grant ON agent_repo_grants(agent_id,repo_id);CREATE UNIQUE INDEX unique_token_hash ON agent_tokens((body->>'hash'));CREATE UNIQUE INDEX unique_dependency ON task_dependencies((body->>'task_id'),(body->>'depends_on'));INSERT INTO schema_migrations(version) VALUES(1)`);
 }
 if(Number(rows[0].v)<2){
 for(const table of tables){
 await c.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_project_fk FOREIGN KEY(project_id) REFERENCES projects(id);ALTER TABLE ${table} ADD CONSTRAINT ${table}_repo_fk FOREIGN KEY(repo_id) REFERENCES repositories(id);ALTER TABLE ${table} ADD CONSTRAINT ${table}_agent_fk FOREIGN KEY(agent_id) REFERENCES agents(id)`);
 }
 await c.query(`CREATE UNIQUE INDEX active_exact_path ON file_reservations(repo_id,(body->>'normalized')) WHERE body->>'state'='active';
 CREATE FUNCTION deny_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are append-only'; END $$;
 CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
 INSERT INTO schema_migrations(version) VALUES(2)`);
 }
 await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');await pool.end();throw e;}finally{c.release();}
 return pool;
}
export async function transaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(431002)');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export function hydrate(r){return r?{...r.body,id:r.id,project_id:r.project_id,repo_id:r.repo_id,agent_id:r.agent_id,version:r.version,created_at:r.created_at,updated_at:r.updated_at}:null;}
export async function get(c,table,id){if(!tables.includes(table))throw Error('Invalid table');return hydrate((await c.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]);}
export async function list(c,table){if(!tables.includes(table))throw Error('Invalid table');return(await c.query(`SELECT * FROM ${table} ORDER BY created_at,id`)).rows.map(hydrate);}
export async function put(c,table,x){if(!tables.includes(table))throw Error('Invalid table');const{id,project_id=null,repo_id=null,agent_id=null,version,created_at,updated_at,...body}=x;return hydrate((await c.query(`INSERT INTO ${table}(id,project_id,repo_id,agent_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET body=excluded.body,project_id=excluded.project_id,repo_id=excluded.repo_id,agent_id=excluded.agent_id,version=${table}.version+1,updated_at=now() RETURNING *`,[id,project_id,repo_id,agent_id,body])).rows[0]);}
