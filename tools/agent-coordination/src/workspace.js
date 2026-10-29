import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Use a short lowercase repo slug');
const id = z.string().trim().min(1).max(128);
const short = z.string().trim().min(1).max(500);
const key = z.string().trim().min(1).max(128);
const body = z.string().trim().min(1).max(16384);
const paging = { limit: z.number().int().min(1).max(50).default(20), full: z.boolean().default(false) };
const cursor = z.object({ workspace_id: id, sequence: z.number().int().nonnegative().safe() });
export const workspaceSchemas = {
  workspace_create: z.object({ name: short }),
  workspace_join: z.object({ workspace_id: id, repo_id: slug, role: short.optional(), path: z.string().max(4096).refine(p => path.isAbsolute(p), 'Repo path must be absolute').optional() }),
  workspace_list_repos: z.object({ workspace_id: id, after_repo: slug.optional(), limit: paging.limit }),
  status_post: z.object({ repo_id: slug, agent_id: id, task: short, state: z.enum(['working', 'blocked', 'done', 'needs-input']), summary: body }),
  status_get: z.object({ workspace_id: id, repo_id: slug.optional(), after: z.number().int().nonnegative().safe().default(0), ...paging }),
  context_publish: z.object({ workspace_id: id, from_repo: slug, key, content: body, type: z.string().trim().min(1).max(64), tags: z.array(z.string().trim().min(1).max(48)).max(20).default([]) }),
  context_get: z.object({ workspace_id: id, key: key.optional(), from_repo: slug.optional(), since: z.union([z.number().int().nonnegative().safe(), z.iso.datetime({ offset: true })]).optional(), after: z.number().int().nonnegative().safe().default(0), ...paging }),
  handoff_send: z.object({ workspace_id: id, from_repo: slug, to_repo: slug, message: body, priority: z.number().int().min(1).max(5).default(3) }),
  handoff_inbox: z.object({ repo_id: slug, state: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'), after: z.number().int().nonnegative().safe().default(0), ...paging }),
  handoff_ack: z.object({ workspace_id: id, handoff_id: id }),
  handoff_resolve: z.object({ workspace_id: id, handoff_id: id }),
  changes_since: z.object({ repo_id: slug, cursor: cursor.nullish(), ...paging }),
};

// Reject likely credentials before any write, including event/audit payloads. This is
// a defensive heuristic, not a replacement for publishing only reviewed, non-secret data.
export function rejectSecrets(value) {
  const text = JSON.stringify(value);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,})/i.test(text)) {
    throw new Error('Possible secret detected; publish variable names or redacted examples only');
  }
  // Scan the original strings so escaped JSON quotes cannot hide assignments.
  const scan = v => {
    if (typeof v === 'string') {
      const assignments = v.matchAll(/["']?\b(?:[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|secret|password|passwd|token))\b["']?\s*[:=]\s*["']?([^\s,"';}\n]+)/gi);
      for (const [, candidate] of assignments) {
        if (!/^(?:<[^>]*>|\$|\[REDACTED\]|REDACTED|\*+|YOUR_|example|placeholder)/i.test(candidate)) {
          throw new Error('Possible secret assignment detected; publish variable names or redacted examples only');
        }
      }
      if (/:\/\/[^\s/:]+:[^\s/@]+@/.test(v)) throw new Error('Credentials in URLs must be redacted');
    } else if (v && typeof v === 'object') for (const item of Object.values(v)) scan(item);
  };
  scan(value);
}

export function workspaceDatabasePath(env = process.env) {
  const file = env.AGENT_COORDINATION_WORKSPACE_DB || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'local-agent-coordination', 'workspaces.sqlite');
  if (!path.isAbsolute(file)) throw new Error('Workspace database path must be absolute');
  return file;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
function retryBusy(fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return fn(); } catch (error) {
      if (!/^SQLITE_(BUSY|LOCKED)/.test(error.code ?? '') || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 50);
    }
  }
}

export class WorkspaceStore {
  constructor(file = workspaceDatabasePath(), { staleMinutes = 15, clock = () => new Date() } = {}) {
    if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) throw new Error('Stale minutes must be positive');
    this.file = path.resolve(file);
    this.clock = clock;
    this.staleMs = staleMinutes * 60000;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const existed = existsSync(file);
    this.db = new Database(file);
    try {
      if (!existed) chmodSync(file, 0o600);
      this.db.pragma('busy_timeout = 5000');
      retryBusy(() => this.db.pragma('journal_mode = WAL'));
      this.db.pragma('foreign_keys = ON');
      retryBusy(() => this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true });
        if (version > 1) throw new Error('Workspace database schema is newer than this service supports');
        if (version === 0) this.db.exec(`
          CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_id TEXT NOT NULL, agent_id TEXT NOT NULL, timestamp TEXT NOT NULL, version INTEGER NOT NULL);
          CREATE TABLE repos (workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), repo_id TEXT NOT NULL, agent_id TEXT NOT NULL, timestamp TEXT NOT NULL, version INTEGER NOT NULL, role TEXT, path TEXT, last_active TEXT NOT NULL, PRIMARY KEY(workspace_id, repo_id));
          CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), repo_id TEXT NOT NULL, agent_id TEXT NOT NULL, timestamp TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, entity_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(workspace_id,kind,entity_key,version));
          CREATE INDEX workspace_events ON events(workspace_id, cursor);
          CREATE INDEX workspace_entities ON events(workspace_id, kind, entity_key, cursor);
          PRAGMA user_version = 1;
        `);
      }).immediate());
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  now() { return this.clock().toISOString(); }
  tx(fn) { return this.db.transaction(fn).immediate(); }
  workspace(id) {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id=?').get(id);
    if (!row) throw new Error(`Unknown workspace: ${id}`);
    return row;
  }
  repo(workspace, repo) {
    this.workspace(workspace);
    const row = this.db.prepare('SELECT * FROM repos WHERE workspace_id=? AND repo_id=?').get(workspace, repo);
    if (!row) throw new Error(`Repo ${repo} has not joined workspace ${workspace}`);
    return row;
  }
  actor(actor) {
    id.parse(actor.agent_id); slug.parse(actor.repo_id);
    this.repo(actor.workspace_id, actor.repo_id);
  }
  scope(input, actor, source = 'repo_id') {
    this.actor(actor);
    if (input.workspace_id && input.workspace_id !== actor.workspace_id) throw new Error('Workspace does not match this session');
    if (input[source] && input[source] !== actor.repo_id) throw new Error('Source repo does not match this session');
    if (input.agent_id && input.agent_id !== actor.agent_id) throw new Error('Agent does not match this session');
  }
  emit(actor, kind, entityKey, data) {
    rejectSecrets({ ...actor, data });
    if (Buffer.byteLength(JSON.stringify(data)) > 24576) throw new Error('Entry exceeds 24 KiB');
    const version = this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM events WHERE workspace_id=? AND kind=? AND entity_key=?').get(actor.workspace_id, kind, entityKey).n;
    const timestamp = this.now();
    const result = this.db.prepare('INSERT INTO events(workspace_id,repo_id,agent_id,timestamp,version,kind,entity_key,data) VALUES(?,?,?,?,?,?,?,?)')
      .run(actor.workspace_id, actor.repo_id, actor.agent_id, timestamp, version, kind, entityKey, JSON.stringify(data));
    this.db.prepare('UPDATE repos SET last_active=? WHERE workspace_id=? AND repo_id=?').run(timestamp, actor.workspace_id, actor.repo_id);
    return this.decode(this.db.prepare('SELECT * FROM events WHERE cursor=?').get(result.lastInsertRowid), true);
  }
  decode(row, full = false) {
    const result = { ...row, ...JSON.parse(row.data) };
    delete result.data; delete result.entity_key;
    result.truncated = false;
    for (const field of ['content', 'summary', 'message']) if (typeof result[field] === 'string' && !full && result[field].length > 320) {
      result[field] = result[field].slice(0, 320) + '…'; result.truncated = true;
    }
    if (row.kind === 'status') result.stale = this.clock().getTime() - Date.parse(row.timestamp) > this.staleMs;
    return result;
  }
  page(rows, input) {
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const item = this.decode(row, input.full);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 32768 && items.length) break;
      items.push(item); bytes += size;
    }
    return { items, has_more: rows.length > items.length, next_after: items.at(-1)?.cursor ?? input.after ?? 0 };
  }
  create(input, actor) {
    input = workspaceSchemas.workspace_create.parse(input);
    id.parse(actor.agent_id); slug.parse(actor.repo_id); rejectSecrets({ input, actor });
    return this.tx(() => {
      const row = { workspace_id: randomUUID(), name: input.name, repo_id: actor.repo_id, agent_id: actor.agent_id, timestamp: this.now(), version: 1 };
      this.db.prepare('INSERT INTO workspaces VALUES(@workspace_id,@name,@repo_id,@agent_id,@timestamp,@version)').run(row);
      return row;
    });
  }
  join(input, agentId) {
    input = workspaceSchemas.workspace_join.parse(input); id.parse(agentId); rejectSecrets(input);
    if (input.path) {
      const relative = path.relative(input.path, this.file);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Workspace database must be outside every linked repo');
      }
    }
    return this.tx(() => {
      this.workspace(input.workspace_id);
      const previous = this.db.prepare('SELECT * FROM repos WHERE workspace_id=? AND repo_id=?').get(input.workspace_id, input.repo_id);
      if (previous?.path && input.path && path.normalize(previous.path) !== path.normalize(input.path)) throw new Error('Repo slug already registered with a different path');
      if (previous?.role && input.role && previous.role !== input.role) throw new Error('Repo slug already registered with a different role');
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO repos VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,repo_id) DO UPDATE SET agent_id=excluded.agent_id,timestamp=excluded.timestamp,version=excluded.version,role=excluded.role,path=excluded.path,last_active=excluded.last_active`)
        .run(input.workspace_id, input.repo_id, agentId, timestamp, (previous?.version ?? 0) + 1, input.role ?? previous?.role ?? null, input.path ?? previous?.path ?? null, timestamp);
      const actor = { workspace_id: input.workspace_id, repo_id: input.repo_id, agent_id: agentId };
      this.emit(actor, 'repo_join', input.repo_id, { role: input.role ?? previous?.role ?? null, path: input.path ?? previous?.path ?? null });
      return this.repo(input.workspace_id, input.repo_id);
    });
  }
  listRepos(input, actor) {
    input = workspaceSchemas.workspace_list_repos.parse(input); this.scope(input, actor);
    const rows = this.db.prepare('SELECT * FROM repos WHERE workspace_id=? AND repo_id>? ORDER BY repo_id LIMIT ?').all(input.workspace_id, input.after_repo ?? '', input.limit + 1);
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 32768 && items.length) break;
      items.push(row); bytes += size;
    }
    return { items, has_more: rows.length > items.length, next_after_repo: items.at(-1)?.repo_id ?? input.after_repo ?? null };
  }
  postStatus(input, actor) {
    input = workspaceSchemas.status_post.parse(input); this.scope(input, actor);
    return this.tx(() => this.emit(actor, 'status', JSON.stringify([actor.repo_id, actor.agent_id]), { task: input.task, state: input.state, summary: input.summary }));
  }
  getStatus(input, actor) {
    input = workspaceSchemas.status_get.parse(input); this.scope({ workspace_id: input.workspace_id }, actor);
    if (input.repo_id) this.repo(input.workspace_id, input.repo_id);
    const rows = this.db.prepare(`SELECT * FROM events e WHERE workspace_id=? AND kind='status' AND (? IS NULL OR repo_id=?) AND cursor>? AND NOT EXISTS(SELECT 1 FROM events n WHERE n.workspace_id=e.workspace_id AND n.kind=e.kind AND n.entity_key=e.entity_key AND n.cursor>e.cursor) ORDER BY cursor LIMIT ?`)
      .all(input.workspace_id, input.repo_id ?? null, input.repo_id ?? null, input.after, input.limit + 1);
    return this.page(rows, input);
  }
  publish(input, actor) {
    input = workspaceSchemas.context_publish.parse(input); this.scope(input, actor, 'from_repo');
    return this.tx(() => this.emit(actor, 'context', JSON.stringify([input.from_repo, input.key]), { from_repo: input.from_repo, key: input.key, content: input.content, type: input.type, tags: input.tags }));
  }
  getContext(input, actor) {
    input = workspaceSchemas.context_get.parse(input); this.scope({ workspace_id: input.workspace_id }, actor);
    if (input.from_repo) this.repo(input.workspace_id, input.from_repo);
    if (typeof input.since === 'number' && (!input.key || !input.from_repo)) throw new Error('Numeric since is a context version; supply key and from_repo');
    const rows = this.db.prepare(`SELECT * FROM events WHERE workspace_id=? AND kind='context' AND (? IS NULL OR json_extract(data,'$.key')=?) AND (? IS NULL OR repo_id=?) AND cursor>? AND version>? AND timestamp>? ORDER BY cursor LIMIT ?`)
      .all(input.workspace_id, input.key ?? null, input.key ?? null, input.from_repo ?? null, input.from_repo ?? null, input.after, typeof input.since === 'number' ? input.since : 0, typeof input.since === 'string' ? new Date(input.since).toISOString() : '', input.limit + 1);
    return this.page(rows, input);
  }
  send(input, actor) {
    input = workspaceSchemas.handoff_send.parse(input); this.scope(input, actor, 'from_repo');
    return this.tx(() => {
      this.repo(input.workspace_id, input.to_repo);
      const handoff_id = randomUUID();
      return this.emit(actor, 'handoff', handoff_id, { handoff_id, from_repo: input.from_repo, to_repo: input.to_repo, message: input.message, priority: input.priority, state: 'open' });
    });
  }
  inbox(input, actor) {
    input = workspaceSchemas.handoff_inbox.parse(input); this.scope(input, actor);
    const rows = this.db.prepare(`SELECT * FROM events e WHERE workspace_id=? AND kind='handoff' AND json_extract(data,'$.to_repo')=? AND (?='all' OR json_extract(data,'$.state')=?) AND cursor>? AND NOT EXISTS(SELECT 1 FROM events n WHERE n.workspace_id=e.workspace_id AND n.kind=e.kind AND n.entity_key=e.entity_key AND n.cursor>e.cursor) ORDER BY cursor LIMIT ?`)
      .all(actor.workspace_id, input.repo_id, input.state, input.state, input.after, input.limit + 1);
    return this.page(rows, input);
  }
  transition(input, actor, state) {
    input = workspaceSchemas[state === 'acknowledged' ? 'handoff_ack' : 'handoff_resolve'].parse(input); this.scope(input, actor);
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM events WHERE workspace_id=? AND kind='handoff' AND entity_key=? ORDER BY cursor DESC LIMIT 1").get(input.workspace_id, input.handoff_id);
      if (!row) throw new Error('Unknown handoff');
      const data = JSON.parse(row.data);
      if (data.to_repo !== actor.repo_id) throw new Error('Only the destination repo may acknowledge or resolve this handoff');
      if (data.state === state) return this.decode(row, true);
      if (data.state === 'resolved') throw new Error('Resolved handoffs cannot be reopened');
      return this.emit(actor, 'handoff', input.handoff_id, { ...data, state });
    });
  }
  changes(input, actor) {
    input = workspaceSchemas.changes_since.parse(input); this.scope(input, actor);
    if (input.cursor && input.cursor.workspace_id !== actor.workspace_id) throw new Error('Cursor belongs to another workspace');
    const high = this.db.prepare('SELECT COALESCE(MAX(cursor),0) AS n FROM events WHERE workspace_id=?').get(actor.workspace_id).n;
    const after = input.cursor?.sequence ?? 0;
    if (after > high) throw new Error('Cursor is ahead of this workspace');
    const rows = this.db.prepare('SELECT * FROM events WHERE workspace_id=? AND repo_id<>? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?').all(actor.workspace_id, actor.repo_id, after, high, input.limit + 1);
    const page = this.page(rows, { ...input, after });
    return { items: page.items, has_more: page.has_more, cursor: { workspace_id: actor.workspace_id, sequence: page.has_more ? page.next_after : high } };
  }
}
