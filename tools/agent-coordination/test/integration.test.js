import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { Coordination } from '../src/core.js';
import { migrations, openDatabase } from '../src/db.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = () => mkdtempSync(path.join(os.tmpdir(), 'agent-coordination-'));
const register = (core, id, role) => core.registerAgent({ id, display_name: id, role, capabilities: [], metadata: {} });

test('version 1 data survives migration to file coordination schema', () => {
  const root = temp();
  const file = path.join(root, 'coordination.sqlite');
  const old = new Database(file);
  try {
    old.exec(migrations[0]);
    old.pragma('user_version = 1');
    old.prepare('INSERT INTO agents VALUES (?,?,?,?,?,?,?)').run('cursor-backend', 'Cursor', 'backend', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}');
  } finally { old.close(); }
  const migrated = openDatabase(file);
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 2);
    assert.equal(migrated.prepare('SELECT display_name FROM agents WHERE id=?').get('cursor-backend').display_name, 'Cursor');
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM file_reservations').get().n, 0);
  } finally { migrated.close(); rmSync(root, { recursive: true, force: true }); }
});

test('coordination lifecycle persists, enforces ownership, dependencies, and audit', () => {
  const root = temp();
  const file = path.join(root, 'coordination.sqlite');
  const core = new Coordination(openDatabase(file));
  try {
    register(core, 'cursor-backend', 'backend');
    register(core, 'antigravity-frontend', 'frontend');
    const backendTask = core.createTask({ creator_agent_id: 'cursor-backend', title: 'API', description: 'Build endpoint', acceptance_criteria: ['Returns JSON'] });
    const frontendTask = core.createTask({ creator_agent_id: 'antigravity-frontend', title: 'UI', description: 'Integrate endpoint', acceptance_criteria: ['Displays data'] });
    core.addDependency({ task_id: frontendTask.id, depends_on_task_id: backendTask.id, actor_agent_id: 'antigravity-frontend' });
    assert.throws(() => core.addDependency({ task_id: backendTask.id, depends_on_task_id: frontendTask.id, actor_agent_id: 'cursor-backend' }), /cycle/);
    core.claimTask({ task_id: frontendTask.id, agent_id: 'antigravity-frontend' });
    assert.throws(() => core.claimTask({ task_id: frontendTask.id, agent_id: 'cursor-backend' }), /already claimed|assigned/);
    assert.throws(() => core.completeTask({ task_id: frontendTask.id, agent_id: 'antigravity-frontend', completion_details: 'Done', verification_evidence: 'Test passed' }), /Incomplete dependencies/);
    core.updateTask({ task_id: frontendTask.id, actor_agent_id: 'antigravity-frontend', status: 'blocked', blockers: ['Await API'], progress: 40 });
    assert.throws(() => core.completeTask({ task_id: frontendTask.id, agent_id: 'antigravity-frontend', completion_details: 'Done', verification_evidence: 'Test passed' }), /blockers/);
    core.claimTask({ task_id: backendTask.id, agent_id: 'cursor-backend' });
    core.completeTask({ task_id: backendTask.id, agent_id: 'cursor-backend', completion_details: 'Endpoint implemented', verification_evidence: 'API test passed' });
    core.updateTask({ task_id: frontendTask.id, actor_agent_id: 'antigravity-frontend', status: 'in_progress', blockers: [], progress: 80 });
    core.completeTask({ task_id: frontendTask.id, agent_id: 'antigravity-frontend', completion_details: 'UI integrated', verification_evidence: 'Browser check passed' });
    const message = core.sendMessage({ sender_agent_id: 'cursor-backend', recipient_agent_id: 'antigravity-frontend', task_id: backendTask.id, subject: 'API ready', body: 'Use GET /api/data' });
    assert.equal(core.listMessages({ agent_id: 'antigravity-frontend', unacknowledged_only: true }).length, 1);
    assert.throws(() => core.acknowledgeMessage({ message_id: message.id, agent_id: 'cursor-backend' }), /recipient/);
    core.acknowledgeMessage({ message_id: message.id, agent_id: 'antigravity-frontend' });
    const change = core.createChangeRequest({ requester_agent_id: 'antigravity-frontend', recipient_agent_id: 'cursor-backend', linked_task_id: backendTask.id,
      affected_files: ['src/api.js'], current_behavior: 'No filter', expected_behavior: 'Filter query', rationale: 'UI requires filtering', acceptance_criteria: ['Filtered response'], compatibility_impact: 'Additive' });
    assert.throws(() => core.respondChangeRequest({ change_request_id: change.id, agent_id: 'antigravity-frontend', status: 'accepted', response_reason: 'OK' }), /recipient/);
    core.respondChangeRequest({ change_request_id: change.id, agent_id: 'cursor-backend', status: 'accepted', response_reason: 'Will add' });
    core.respondChangeRequest({ change_request_id: change.id, agent_id: 'cursor-backend', status: 'completed', response_reason: 'Added and tested' });
    assert.equal(core.getTask(frontendTask.id).status, 'completed');
    assert.equal(core.snapshot('antigravity-frontend').unread_messages.length, 0);
    assert.ok(core.listAudit({ entity_type: 'task', entity_id: frontendTask.id }).length >= 5);
  } finally { core.close(); }
  const reopened = new Coordination(openDatabase(file));
  try {
    assert.equal(reopened.listTasks().length, 2);
    assert.equal(reopened.listChangeRequests({ agent_id: 'cursor-backend' })[0].status, 'completed');
    assert.equal(reopened.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(reopened.db.pragma('foreign_key_check').length, 0);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real stdio MCP client discovers and calls tools', async () => {
  const root = temp();
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  const peer = new Client({ name: 'integration-peer', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(serviceRoot, 'src', 'server.js')],
    env: { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root } });
  const peerTransport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(serviceRoot, 'src', 'server.js')],
    env: { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root } });
  try {
    await Promise.all([client.connect(transport), peer.connect(peerTransport)]);
    const names = (await client.listTools()).tools.map(x => x.name);
    assert.ok(names.includes('agent_register'));
    assert.ok(names.includes('task_claim'));
    const registration = await client.callTool({ name: 'agent_register', arguments: {
      id: 'cursor-backend', display_name: 'Cursor Backend', role: 'backend', capabilities: ['Node.js']
    } });
    assert.equal(registration.isError, undefined);
    assert.equal(registration.structuredContent.result.id, 'cursor-backend');
    await peer.callTool({ name: 'agent_register', arguments: {
      id: 'antigravity-frontend', display_name: 'Antigravity Frontend', role: 'frontend', capabilities: ['UI']
    } });
    const created = await client.callTool({ name: 'task_create', arguments: {
      creator_agent_id: 'cursor-backend', assignee_agent_id: 'antigravity-frontend',
      title: 'Integrate API', description: 'Use the new endpoint', acceptance_criteria: ['Data visible']
    } });
    assert.equal(created.isError, undefined);
    const taskId = created.structuredContent.result.id;
    const claimed = await peer.callTool({ name: 'task_claim', arguments: { task_id: taskId, agent_id: 'antigravity-frontend' } });
    assert.equal(claimed.structuredContent.result.claimed_by_agent_id, 'antigravity-frontend');
    const observed = await client.callTool({ name: 'task_get', arguments: { task_id: taskId } });
    assert.equal(observed.structuredContent.result.status, 'in_progress');
    const snapshot = await client.callTool({ name: 'state_snapshot', arguments: { agent_id: 'cursor-backend' } });
    assert.equal(snapshot.structuredContent.result.agent.role, 'backend');
    const invalid = await client.callTool({ name: 'task_claim', arguments: { task_id: 'missing', agent_id: 'cursor-backend' } });
    assert.equal(invalid.isError, true);
  } finally {
    await Promise.all([client.close(), peer.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});
