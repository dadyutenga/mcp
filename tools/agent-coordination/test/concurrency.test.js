import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordination } from '../src/core.js';
import { openDatabase } from '../src/db.js';
import { FileCoordination } from '../src/files.js';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claim-worker.js');
const startupWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'startup-worker.js');
const reserveWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'file-reserve-worker.js');
function runProcess(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args]);
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
}

test('two independent processes cannot claim the same task', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-claim-'));
  const file = path.join(root, 'coordination.sqlite');
  const core = new Coordination(openDatabase(file));
  try {
    for (const id of ['creator', 'agent-a', 'agent-b']) core.registerAgent({ id, display_name: id, role: 'other', capabilities: [], metadata: {} });
    const task = core.createTask({ creator_agent_id: 'creator', title: 'Shared task', description: 'Claim once' });
    const results = (await Promise.all([
      runProcess(worker, [file, task.id, 'agent-a']), runProcess(worker, [file, task.id, 'agent-b'])
    ])).map(JSON.parse);
    assert.equal(results.filter(x => x.claimed).length, 1);
    assert.equal(core.getTask(task.id).claimed_by_agent_id, results.find(x => x.claimed).agent);
    assert.equal(core.listAudit({ entity_type: 'task', entity_id: task.id }).filter(x => x.action === 'claimed').length, 1);
  } finally { core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('eight independent processes can initialize one new database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-startup-'));
  const file = path.join(root, 'coordination.sqlite');
  try {
    const versions = await Promise.all(Array.from({ length: 8 }, () => runProcess(startupWorker, [file])));
    assert.deepEqual(versions, Array(8).fill('2'));
    const db = openDatabase(file);
    try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two database connections and two Node processes cannot acquire conflicting write reservations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-file-race-'));
  const file = path.join(root, 'coordination.sqlite');
  const first = new Coordination(openDatabase(file));
  const second = new Coordination(openDatabase(file));
  try {
    const tasks = {};
    for (const id of ['cursor-backend', 'antigravity-frontend']) {
      first.registerAgent({ id, display_name: id, role: id === 'cursor-backend' ? 'backend' : 'frontend', capabilities: [], metadata: {} });
      tasks[id] = first.createTask({ creator_agent_id: id, title: 'Shared config', description: 'Edit package.json' }).id;
      first.claimTask({ task_id: tasks[id], agent_id: id });
    }
    const a = new FileCoordination(first, { root });
    const b = new FileCoordination(second, { root });
    assert.equal(a.conflictCheck({ agent_id: 'cursor-backend', task_id: tasks['cursor-backend'], file_paths: ['package.json'] }).safe_to_proceed, true);
    assert.equal(b.reserve({ agent_id: 'antigravity-frontend', task_id: tasks['antigravity-frontend'], file_path: 'package.json' }).acquired, true);
    assert.equal(a.reserve({ agent_id: 'cursor-backend', task_id: tasks['cursor-backend'], file_path: 'PACKAGE.JSON' }).acquired, false);
    b.release({ agent_id: 'antigravity-frontend', reservation_id: b.listReservations({ status: 'active' })[0].id, release_reason: 'Race setup complete' });
    const results = (await Promise.all([
      runProcess(reserveWorker, [file, root, 'cursor-backend', tasks['cursor-backend'], 'package.json']),
      runProcess(reserveWorker, [file, root, 'antigravity-frontend', tasks['antigravity-frontend'], 'PACKAGE.JSON'])
    ])).map(JSON.parse);
    assert.equal(results.filter(x => x.acquired).length, 1);
    assert.equal(first.db.prepare("SELECT count(*) AS n FROM file_reservations WHERE status='active'").get().n, 1);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});
