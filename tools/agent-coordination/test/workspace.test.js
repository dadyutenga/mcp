import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceStore, workspaceDatabasePath, rejectSecrets } from '../src/workspace.js';

const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
const worker = fileURLToPath(new URL('./workspace-worker.js', import.meta.url));
const temp = () => mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
function fixture(options) {
  const root = temp(), file = path.join(root, 'central', 'shared.sqlite');
  const store = new WorkspaceStore(file, options);
  const a = { repo_id: 'backend', agent_id: 'same-agent' };
  const w = store.create({ name: 'ride-hailing' }, a);
  a.workspace_id = w.workspace_id;
  const b = { ...a, repo_id: 'admin-ui' };
  for (const actor of [a, b]) store.join({ workspace_id: w.workspace_id, repo_id: actor.repo_id }, actor.agent_id);
  return { root, file, store, a, b, workspace_id: w.workspace_id, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const publish = (f, content, extra = {}) => f.store.publish({ workspace_id: f.workspace_id, from_repo: f.a.repo_id, key: 'api', content, type: 'contract', ...extra }, f.a);
const status = (f, extra = {}) => f.store.postStatus({ repo_id: f.a.repo_id, agent_id: f.a.agent_id, task: 'API', state: 'working', summary: 'Building endpoint', ...extra }, f.a);
async function connect(root, file, extra = {}) {
  const env = { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root, AGENT_COORDINATION_WORKSPACE_DB: file, ...extra };
  delete env.AGENT_COORDINATION_WORKSPACE_ID; delete env.AGENT_COORDINATION_REPO_ID;
  Object.assign(env, extra);
  const c = new Client({ name: 'workspace-test', version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'inherit' }));
  return c;
}
async function call(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  return r.structuredContent.result;
}
async function register(c) { await call(c, 'agent_register', { id: 'cursor-backend', display_name: 'Test agent', role: 'backend' }); }

// Different roots, same central DB, same agent ID: the repo remains part of identity.
test('two distinct repos share status, context and handoffs through real stdio MCP; restart restores configured scope', async () => {
  const root = temp(), file = path.join(root, 'central', 'workspaces.sqlite');
  const backend = path.join(root, 'backend'), frontend = path.join(root, 'frontend');
  mkdirSync(backend); mkdirSync(frontend);
  let a, b, restarted;
  try {
    a = await connect(backend, file); b = await connect(frontend, file);
    await register(a); await register(b);
    const names = (await a.listTools()).tools.map(t => t.name);
    for (const name of ['workspace_create', 'workspace_join', 'workspace_list_repos', 'status_post', 'status_get', 'context_publish', 'context_get', 'handoff_send', 'handoff_inbox', 'handoff_ack', 'handoff_resolve', 'changes_since']) assert.ok(names.includes(name));
    const w = await call(a, 'workspace_create', { name: 'ride-hailing' });
    const workspace_id = w.workspace_id;
    await call(a, 'workspace_join', { workspace_id, repo_id: 'backend', path: backend, role: 'backend' });
    await call(b, 'workspace_join', { workspace_id, repo_id: 'admin-ui', path: frontend, role: 'frontend' });
    const repos = await call(b, 'workspace_list_repos', { workspace_id });
    assert.equal(repos.items.length, 2); assert.ok(repos.items.every(r => r.last_active && r.agent_id && r.version));
    await call(a, 'status_post', { repo_id: 'backend', agent_id: 'cursor-backend', task: 'API', state: 'working', summary: 'Adding rides' });
    assert.equal((await call(b, 'status_get', { workspace_id })).items[0].repo_id, 'backend');
    const context = await call(a, 'context_publish', { workspace_id, from_repo: 'backend', key: 'rides', type: 'endpoint', content: 'GET /rides returns {rides: []}' });
    assert.equal((await call(b, 'context_get', { workspace_id, key: 'rides' })).items[0].content, context.content);
    const handoff = await call(b, 'handoff_send', { workspace_id, from_repo: 'admin-ui', to_repo: 'backend', message: 'Please add pagination', priority: 4 });
    assert.equal((await call(a, 'handoff_inbox', { repo_id: 'backend' })).items.length, 1);
    await call(a, 'handoff_ack', { workspace_id, handoff_id: handoff.handoff_id });
    await call(a, 'handoff_resolve', { workspace_id, handoff_id: handoff.handoff_id });
    assert.equal((await call(a, 'handoff_inbox', { repo_id: 'backend' })).items.length, 0);
    assert.equal((await call(a, 'handoff_inbox', { repo_id: 'backend', state: 'resolved' })).items[0].version, 3);
    const changes = await call(b, 'changes_since', { repo_id: 'admin-ui' });
    assert.ok(changes.items.some(e => e.kind === 'context'));
    assert.ok(changes.items.every(e => e.repo_id === 'backend'));
    assert.equal((await call(b, 'changes_since', { repo_id: 'admin-ui', cursor: changes.cursor })).items.length, 0);
    for (const [name, args, pattern] of [
      ['status_post', { repo_id: 'backend', agent_id: 'cursor-backend', task: 'Fake', state: 'done', summary: 'Fake' }, /Source repo/],
      ['status_post', { repo_id: 'admin-ui', agent_id: 'other', task: 'Fake', state: 'done', summary: 'Fake' }, /Agent does not match/],
      ['context_publish', { workspace_id, from_repo: 'backend', key: 'fake', type: 'api', content: 'Fake' }, /Source repo/],
      ['workspace_join', { workspace_id, repo_id: 'backend' }, /does not match this session/],
      ['handoff_ack', { workspace_id, handoff_id: handoff.handoff_id }, /destination repo/],
    ]) {
      const r = await b.callTool({ name, arguments: args }); assert.equal(r.isError, true); assert.match(r.content[0].text, pattern);
    }
    // The old task namespace stays local even after a workspace is joined.
    await call(a, 'task_create', { creator_agent_id: 'cursor-backend', title: 'Local', description: 'Backend only' });
    assert.equal((await call(b, 'task_list')).length, 0);
    await a.close(); a = null;
    restarted = await connect(backend, file, { AGENT_COORDINATION_WORKSPACE_ID: workspace_id, AGENT_COORDINATION_REPO_ID: 'backend' });
    await register(restarted);
    assert.equal((await call(restarted, 'context_get', { workspace_id })).items.length, 1);
  } finally { await Promise.all([a?.close(), b?.close(), restarted?.close()]); rmSync(root, { recursive: true, force: true }); }
});

test('context is immutable and versioned per source/key; timestamp and cursor filters, summaries, bounded pagination', () => {
  const f = fixture();
  try {
    const v1 = publish(f, 'v1'), v2 = publish(f, 'v2');
    assert.deepEqual([v1.version, v2.version], [1, 2]);
    const filter = { workspace_id: f.workspace_id, key: 'api', from_repo: 'backend' };
    assert.throws(() => f.store.getContext({ workspace_id: f.workspace_id, since: 1 }, f.b), /supply key and from_repo/);
    assert.deepEqual(f.store.getContext(filter, f.b).items.map(x => x.content), ['v1', 'v2']);
    assert.deepEqual(f.store.getContext({ ...filter, since: v1.version }, f.b).items.map(x => x.version), [2]);
    assert.equal(f.store.getContext({ ...filter, since: '2099-01-01T00:00:00Z' }, f.b).items.length, 0);
    const timeFiltered = f.store.getContext({ ...filter, since: '2000-01-01T03:00:00+03:00' }, f.b);
    assert.equal(timeFiltered.items.length, 2);
    publish(f, 'x'.repeat(16000)); publish(f, 'y'.repeat(16000)); publish(f, 'z'.repeat(16000));
    const summary = f.store.getContext({ ...filter, after: v2.cursor }, f.b);
    assert.equal(summary.items[0].truncated, true); assert.ok(summary.items[0].content.length < 400);
    const first = f.store.getContext({ ...filter, full: true }, f.b);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 34000); assert.equal(first.has_more, true);
    const next = f.store.getContext({ ...filter, full: true, after: first.next_after }, f.b);
    assert.ok(next.items[0].cursor > first.next_after);
    const paged = f.store.getContext({ ...filter, limit: 1 }, f.b);
    assert.equal(paged.items.length, 1); assert.equal(paged.has_more, true);
    assert.throws(() => publish(f, 'x'.repeat(16385)), /Too big/);
    assert.throws(() => publish(f, '😀'.repeat(16000)), /24 KiB/);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='context'").get().n, 5);
  } finally { f.close(); }
});

test('handoff acknowledgment/resolution are recipient-only, idempotent and versioned', () => {
  const f = fixture();
  try {
    const h = f.store.send({ workspace_id: f.workspace_id, from_repo: 'backend', to_repo: 'admin-ui', message: 'Add UI', priority: 5 }, f.a);
    const input = { workspace_id: f.workspace_id, handoff_id: h.handoff_id };
    assert.throws(() => f.store.transition(input, f.a, 'acknowledged'), /destination repo/);
    const ack = f.store.transition(input, f.b, 'acknowledged');
    assert.equal(ack.version, 2); assert.equal(ack.repo_id, 'admin-ui');
    assert.equal(f.store.transition(input, f.b, 'acknowledged').cursor, ack.cursor);
    assert.equal(f.store.inbox({ repo_id: 'admin-ui', state: 'acknowledged' }, f.b).items.length, 1);
    const resolved = f.store.transition(input, f.b, 'resolved');
    assert.equal(resolved.version, 3);
    assert.equal(f.store.transition(input, f.b, 'resolved').cursor, resolved.cursor);
    assert.throws(() => f.store.transition(input, f.b, 'acknowledged'), /cannot be reopened/);
    assert.equal(f.store.inbox({ repo_id: 'admin-ui' }, f.b).items.length, 0);
    assert.equal(f.store.changes({ repo_id: 'backend' }, f.a).items.filter(x => x.kind === 'handoff').length, 2);
  } finally { f.close(); }
});

test('stale status, validation and workspace isolation', () => {
  let time = new Date('2026-01-01T00:00:00Z');
  const f = fixture({ clock: () => time });
  try {
    status(f);
    time = new Date(time.getTime() + 16 * 60000);
    assert.equal(f.store.getStatus({ workspace_id: f.workspace_id }, f.b).items[0].stale, true);
    status(f, { state: 'done' });
    const latest = f.store.getStatus({ workspace_id: f.workspace_id }, f.b).items;
    assert.equal(latest.length, 1); assert.equal(latest[0].stale, false); assert.equal(latest[0].version, 2);
    assert.equal(f.store.listRepos({ workspace_id: f.workspace_id }, f.a).items.find(x => x.repo_id === 'backend').last_active, time.toISOString());
    assert.throws(() => f.store.join({ workspace_id: 'missing', repo_id: 'other' }, 'agent'), /Unknown workspace/);
    assert.throws(() => f.store.getContext({ workspace_id: f.workspace_id, from_repo: 'missing' }, f.a), /has not joined/);
    assert.throws(() => f.store.send({ workspace_id: f.workspace_id, from_repo: 'backend', to_repo: 'missing', message: 'Hi' }, f.a), /has not joined/);
    assert.throws(() => f.store.join({ workspace_id: f.workspace_id, repo_id: '../escape' }, 'agent'));
    assert.throws(() => f.store.join({ workspace_id: f.workspace_id, repo_id: 'other', path: 'relative' }, 'agent'), /absolute/);
    assert.throws(() => f.store.join({ workspace_id: f.workspace_id, repo_id: 'other', path: f.root }, 'agent'), /outside every linked repo/);
    const w2 = f.store.create({ name: 'isolated' }, f.a);
    assert.throws(() => f.store.getContext({ workspace_id: w2.workspace_id }, f.a), /does not match/);
    assert.throws(() => f.store.changes({ repo_id: 'backend', cursor: { workspace_id: w2.workspace_id, sequence: 0 } }, f.a), /another workspace/);
    assert.throws(() => f.store.changes({ repo_id: 'backend', cursor: { workspace_id: f.workspace_id, sequence: 9999 } }, f.a), /ahead/);
    const first = f.store.changes({ repo_id: 'admin-ui', limit: 1 }, f.b);
    assert.equal(first.has_more, true);
    const rest = f.store.changes({ repo_id: 'admin-ui', cursor: first.cursor }, f.b);
    assert.ok(rest.items.every(x => x.cursor > first.cursor.sequence));
    assert.equal(f.store.changes({ repo_id: 'admin-ui', cursor: rest.cursor }, f.b).items.length, 0);
    f.store.join({ workspace_id: f.workspace_id, repo_id: 'backend', path: '/one' }, 'agent');
    assert.throws(() => f.store.join({ workspace_id: f.workspace_id, repo_id: 'backend', path: '/two' }, 'agent'), /different path/);
  } finally { f.close(); }
});

test('likely secrets are rejected before persistence, including JSON credentials and handoffs', () => {
  const f = fixture();
  try {
    const initial = f.store.db.prepare('SELECT count(*) AS n FROM events').get().n;
    const samples = ['API_KEY=realcredentialvalue', '{"password":"hunter2"}', 'token: abc123', 'Authorization: Bearer abcdefghijklmnop', 'sk-proj-abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz', 'https://user:pass@example.com', '-----BEGIN PRIVATE KEY-----'];
    for (const content of samples) {
      assert.throws(() => publish(f, content), /secret|redacted|Credentials/);
      assert.throws(() => status(f, { summary: content }), /secret|redacted|Credentials/);
    }
    assert.throws(() => publish(f, 'Fine', { tags: ['password=abc'] }), /secret/);
    assert.throws(() => f.store.send({ workspace_id: f.workspace_id, from_repo: 'backend', to_repo: 'admin-ui', message: 'password=abc' }, f.a), /secret/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n, initial);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events WHERE data LIKE ?').get('%hunter2%').n, 0);
    rejectSecrets('Set API_KEY through environment settings; password=<redacted>; token=$TOKEN');
    publish(f, 'API_KEY=<redacted>');
  } finally { f.close(); }
});

function runWorker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args]); let errors = '';
    child.stderr.on('data', c => { errors += c; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
}
test('concurrent independent processes append all context versions atomically', async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 6 }, () => runWorker([f.file, f.workspace_id, 'backend', '12'])));
    const rows = f.store.db.prepare("SELECT * FROM events WHERE kind='context' ORDER BY version").all();
    assert.equal(rows.length, 72); assert.deepEqual(rows.map(x => x.version), Array.from({ length: 72 }, (_, i) => i + 1));
    assert.equal(f.store.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(f.store.db.pragma('foreign_key_check'), []);
  } finally { f.close(); }
});

test('single-repo mode remains local and never opens the workspace store', async () => {
  const root = temp(), file = path.join(root, 'unused', 'workspaces.sqlite'); let c;
  try {
    c = await connect(root, file); await register(c);
    const t = await call(c, 'task_create', { creator_agent_id: 'cursor-backend', title: 'Legacy', description: 'Single repo' });
    await call(c, 'task_claim', { task_id: t.id, agent_id: 'cursor-backend' });
    assert.equal((await call(c, 'state_snapshot', { agent_id: 'cursor-backend' })).tasks[0].id, t.id);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(path.join(root, '.local', 'agent-coordination', 'coordination.sqlite')), true);
    const r = await c.callTool({ name: 'changes_since', arguments: { repo_id: 'backend' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /workspace_join/);
    // A failed unconfigured call should not create central state either.
    assert.equal(existsSync(file), false);
    const invalid = await c.callTool({ name: 'workspace_create', arguments: { name: 'accidentally-local' } });
    assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /outside the current repo/);
    assert.equal(existsSync(file), false);
    assert.equal(workspaceDatabasePath({ XDG_CONFIG_HOME: '/config' }), path.join('/config', 'local-agent-coordination', 'workspaces.sqlite'));
    assert.throws(() => workspaceDatabasePath({ AGENT_COORDINATION_WORKSPACE_DB: 'relative.sqlite' }), /absolute/);
  } finally { await c?.close(); rmSync(root, { recursive: true, force: true }); }
});
