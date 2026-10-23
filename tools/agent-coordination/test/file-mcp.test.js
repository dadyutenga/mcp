import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Coordination } from '../src/core.js';
import { openDatabase } from '../src/db.js';

const serverScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');
const temp = () => mkdtempSync(path.join(os.tmpdir(), 'file-mcp-'));
async function connect(root, name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverScript],
    env: { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root }, stderr: 'pipe' });
  let errors = '';
  transport.stderr.on('data', chunk => { errors += chunk; });
  await client.connect(transport);
  return { client, errors: () => errors };
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.structuredContent.result;
}

test('full Cursor and Antigravity handoff through two MCP processes, then restart recovery', async () => {
  const root = temp();
  const cursor = await connect(root, 'cursor-test');
  const antigravity = await connect(root, 'antigravity-test');
  const target = 'backend/src/routes/customers.ts';
  try {
    const names = (await cursor.client.listTools()).tools.map(x => x.name);
    for (const name of ['agent_register', 'task_claim', 'file_ownership_check', 'file_reserve', 'file_reserve_batch',
      'file_reservation_list', 'file_reservation_renew', 'file_reservation_release', 'file_conflict_check',
      'file_conflict_list', 'file_ownership_request', 'file_ownership_respond', 'file_ownership_request_list', 'file_coordination_status']) {
      assert.ok(names.includes(name), `${name} missing`);
    }
    await call(cursor.client, 'agent_register', { id: 'cursor-backend', display_name: 'Cursor', role: 'backend' });
    await call(antigravity.client, 'agent_register', { id: 'antigravity-frontend', display_name: 'Antigravity', role: 'frontend' });
    const wrongIdentity = await cursor.client.callTool({ name: 'agent_register', arguments: {
      id: 'antigravity-frontend', display_name: 'Antigravity', role: 'frontend' } });
    assert.equal(wrongIdentity.isError, true);
    const backendTask = await call(cursor.client, 'task_create', { creator_agent_id: 'cursor-backend', title: 'Customer API', description: 'Build API' });
    const frontendTask = await call(antigravity.client, 'task_create', { creator_agent_id: 'antigravity-frontend', title: 'Customer UI', description: 'Integrate API' });
    await call(cursor.client, 'task_claim', { task_id: backendTask.id, agent_id: 'cursor-backend' });
    await call(antigravity.client, 'task_claim', { task_id: frontendTask.id, agent_id: 'antigravity-frontend' });
    const reservation = await call(cursor.client, 'file_reserve', { file_path: target, task_id: backendTask.id, reservation_type: 'exclusive_write' });
    assert.equal(reservation.acquired, true);
    const denied = await call(antigravity.client, 'file_reserve', { file_path: target, task_id: frontendTask.id, reservation_type: 'exclusive_write' });
    assert.equal(denied.acquired, false);
    assert.match(denied.message, /File reserved by cursor-backend/);
    const request = await call(antigravity.client, 'file_ownership_request', { file_path: target, task_id: frontendTask.id,
      reason: 'The UI needs customer totals', expected_changes: 'Add a response field' });
    const inbox = await call(cursor.client, 'message_list', { agent_id: 'cursor-backend', unacknowledged_only: true });
    assert.ok(inbox.some(message => message.subject === 'File ownership approval requested' && message.task_id === frontendTask.id));
    assert.ok(inbox.every(message => !message.body.includes('Add a response field')));
    const requests = await call(cursor.client, 'file_ownership_request_list', {});
    assert.equal(requests.find(item => item.id === request.id).expected_changes, 'Add a response field');
    const approved = await call(cursor.client, 'file_ownership_respond', { ownership_request_id: request.id,
      decision: 'approve', response_message: 'Approved for this task' });
    assert.equal(approved.status, 'approved');
    const stillDenied = await call(antigravity.client, 'file_reserve', { file_path: target, task_id: frontendTask.id, reservation_type: 'exclusive_write' });
    assert.equal(stillDenied.acquired, false);
    assert.equal(stillDenied.conflicts[0].type, 'ACTIVE_WRITE_RESERVATION');
    await call(cursor.client, 'file_reservation_release', { reservation_id: reservation.reservations[0].id, release_reason: 'Finished API edit' });
    const acquired = await call(antigravity.client, 'file_reserve', { file_path: target, task_id: frontendTask.id, reservation_type: 'exclusive_write' });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reservations[0].agent_id, 'antigravity-frontend');
    const history = await call(antigravity.client, 'audit_list', { entity_type: 'file_reservation' });
    assert.ok(history.some(event => event.action === 'acquired'));
    assert.ok(history.some(event => event.action === 'released'));
    assert.equal(cursor.errors(), '');
    assert.equal(antigravity.errors(), '');
  } finally {
    await Promise.all([cursor.client.close(), antigravity.client.close()]);
  }
  const restarted = await connect(root, 'antigravity-restart');
  try {
    await call(restarted.client, 'agent_register', { id: 'antigravity-frontend', display_name: 'Antigravity', role: 'frontend' });
    const active = await call(restarted.client, 'file_reservation_list', { agent_id: 'antigravity-frontend', status: 'active' });
    assert.equal(active.length, 1);
    const status = await call(restarted.client, 'file_coordination_status', {});
    assert.equal(status.active_reservations.length, 1);
    const db = openDatabase(path.join(root, '.local', 'agent-coordination', 'coordination.sqlite'));
    const core = new Coordination(db);
    try {
      assert.equal(core.listAudit({ entity_type: 'ownership_request' }).filter(x => ['requested', 'approved'].includes(x.action)).length, 2);
      assert.equal(db.pragma('foreign_key_check').length, 0);
    } finally { core.close(); }
    assert.equal(restarted.errors(), '');
  } finally {
    await restarted.client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stdio server emits no ordinary startup text on stdout', async () => {
  const root = temp();
  const child = spawn(process.execPath, [serverScript], { env: { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  try {
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(output, '');
    assert.equal(error, '');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('close', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
