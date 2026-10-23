import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordination } from '../src/core.js';
import { openDatabase } from '../src/db.js';
import { FileCoordination } from '../src/files.js';
import { loadPolicy, normalizeFilePath, policyOwner } from '../src/paths.js';

const policy = loadPolicy();
function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-coordination-'));
  const core = new Coordination(openDatabase(path.join(root, '.local', 'agent-coordination', 'coordination.sqlite')));
  const files = new FileCoordination(core, { root, policy: { ...policy, ...overrides } });
  for (const [id, role] of [['cursor-backend', 'backend'], ['antigravity-frontend', 'frontend']]) {
    core.registerAgent({ id, display_name: id, role, capabilities: [], metadata: {} });
  }
  const task = id => {
    const created = core.createTask({ creator_agent_id: id, title: `${id} task`, description: 'Edit files' });
    core.claimTask({ task_id: created.id, agent_id: id });
    return created.id;
  };
  return { root, core, files, task, close: () => { core.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('repository paths normalize Windows separators and reject escapes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-path-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'file-outside-'));
  try {
    assert.deepEqual(normalizeFilePath('frontend\\src\\App.tsx', root),
      { repository_path: 'frontend/src/App.tsx', normalized_path: 'frontend/src/app.tsx' });
    assert.equal(normalizeFilePath('FRONTEND/src/app.tsx', root).normalized_path, 'frontend/src/app.tsx');
    for (const bad of ['', '../secret', 'frontend/../secret', 'C:\\secret.txt', '\\\\server\\share\\file',
      '/etc/passwd', 'frontend//App.tsx', 'frontend/./App.tsx', 'CON.txt', 'src/bad?.js', 'src/trailing.']) {
      assert.throws(() => normalizeFilePath(bad, root));
    }
    mkdirSync(path.join(root, 'frontend'));
    symlinkSync(outside, path.join(root, 'frontend', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => normalizeFilePath('frontend/escape/secret.txt', root), /symlink|junction/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('ownership policy validates and uses last matching rule, case-insensitively', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-policy-'));
  try {
    const file = path.join(root, 'policy.json');
    writeFileSync(file, JSON.stringify({ defaultOwnership: 'shared', leaseSeconds: 2, maxLeaseSeconds: 10,
      approvalSeconds: 20, rules: [{ pattern: 'backend/**', owner: 'cursor-backend' },
        { pattern: 'backend/**/public/**', owner: 'shared' }] }));
    const loaded = loadPolicy(file);
    assert.equal(policyOwner(loaded, 'BACKEND/src/api.ts'), 'cursor-backend');
    assert.equal(policyOwner(loaded, 'backend/public/schema.json'), 'shared');
    assert.equal(policyOwner(loaded, 'backend/src/public/schema.json'), 'shared');
    assert.equal(policyOwner(loaded, 'other/file.ts'), 'shared');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), leaseSeconds: 11 }));
    assert.throws(() => loadPolicy(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reservation, approval, messaging, audit, and task completion scenario', () => {
  const f = fixture();
  try {
    const backendTask = f.task('cursor-backend');
    const frontendTask = f.task('antigravity-frontend');
    const target = 'backend/src/routes/customers.ts';
    const ownerCheck = f.files.ownershipCheck({ agent_id: 'cursor-backend', task_id: backendTask, file_path: target });
    assert.equal(ownerCheck.policy_owner, 'cursor-backend');
    assert.equal(ownerCheck.ownership_allowed, true);
    assert.equal(ownerCheck.active_reservations.length, 0);
    assert.equal(f.files.ownershipCheck({ agent_id: 'cursor-backend', task_id: backendTask, file_path: 'AGENTS.md' }).policy_owner, 'shared');
    const first = f.files.reserve({ agent_id: 'cursor-backend', task_id: backendTask, file_path: target });
    assert.equal(first.acquired, true);
    assert.equal(f.files.reserve({ agent_id: 'cursor-backend', task_id: backendTask, file_path: 'BACKEND\\SRC\\ROUTES\\CUSTOMERS.TS' }).reservations[0].id, first.reservations[0].id);
    const before = f.files.conflictCheck({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_paths: [target] });
    assert.equal(before.safe_to_proceed, false);
    assert.equal(before.reservation_granted, false);
    assert.equal(f.core.listMessages({ agent_id: 'cursor-backend', unacknowledged_only: true }).length, 0);
    const denied = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(denied.acquired, false);
    assert.deepEqual(denied.conflicts.map(x => x.type), ['ACTIVE_WRITE_RESERVATION', 'OWNERSHIP_VIOLATION']);
    assert.match(denied.message, /File reserved by cursor-backend/);
    const inbox = f.core.listMessages({ agent_id: 'cursor-backend', unacknowledged_only: true });
    assert.equal(inbox.length, 2);
    assert.ok(inbox.every(x => x.task_id === frontendTask));
    f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(f.core.listMessages({ agent_id: 'cursor-backend', unacknowledged_only: true }).length, 2);
    const request = f.files.requestOwnership({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: target, reason: 'Frontend integration needs an API adjustment', expected_changes: 'Add customer totals' });
    assert.equal(request.status, 'pending');
    assert.equal(f.core.listMessages({ agent_id: 'cursor-backend', unacknowledged_only: true }).length, 3);
    const approved = f.files.respondOwnership({ agent_id: 'cursor-backend', ownership_request_id: request.id,
      decision: 'approved', response_message: 'Approved for this task' });
    assert.equal(approved.status, 'approved');
    assert.ok(approved.expires_at);
    assert.equal(f.files.ownershipCheck({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: 'backend/src/routes/other.ts' }).ownership_allowed, false);
    const otherTask = f.task('antigravity-frontend');
    assert.equal(f.files.ownershipCheck({ agent_id: 'antigravity-frontend', task_id: otherTask,
      file_path: target }).ownership_allowed, false);
    const stillDenied = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(stillDenied.acquired, false);
    assert.deepEqual(stillDenied.conflicts.map(x => x.type), ['ACTIVE_WRITE_RESERVATION']);
    assert.throws(() => f.core.completeTask({ task_id: frontendTask, agent_id: 'antigravity-frontend',
      completion_details: 'Done', verification_evidence: 'Test passed' }), /critical file conflicts/);
    const released = f.files.release({ agent_id: 'cursor-backend', reservation_id: first.reservations[0].id, release_reason: 'API edit finished' });
    assert.equal(released.status, 'released');
    assert.equal(f.files.release({ agent_id: 'cursor-backend', reservation_id: released.id, release_reason: 'Repeated' }).release_reason, 'API edit finished');
    const acquired = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reservations[0].agent_id, 'antigravity-frontend');
    assert.ok(f.core.listAudit({ entity_type: 'file_reservation' }).length >= 3);
    assert.ok(f.core.listAudit({ entity_type: 'file_conflict' }).length >= 4);
    assert.ok(f.core.listAudit({ entity_type: 'ownership_request' }).length >= 2);
    assert.equal(f.files.listConflicts({ task_id: frontendTask, status: 'open' }).length, 0);
    f.core.completeTask({ task_id: frontendTask, agent_id: 'antigravity-frontend', completion_details: 'Done', verification_evidence: 'Test passed' });
    assert.equal(f.files.release({ agent_id: 'antigravity-frontend', reservation_id: acquired.reservations[0].id,
      release_reason: 'Task completed' }).status, 'released');
  } finally { f.close(); }
});

test('batch failure creates no reservations; shared files still need exclusive locks', () => {
  const f = fixture();
  try {
    const frontTask = f.task('antigravity-frontend');
    const backTask = f.task('cursor-backend');
    const batch = f.files.reserveBatch({ agent_id: 'antigravity-frontend', task_id: frontTask,
      file_paths: ['frontend/src/App.tsx', 'FRONTEND\\src\\app.tsx', 'frontend/src/components/Dashboard.tsx', 'backend/src/api.ts'] });
    assert.equal(batch.acquired, false);
    assert.equal(f.files.listReservations({ task_id: frontTask }).length, 0);
    const successful = f.files.reserveBatch({ agent_id: 'antigravity-frontend', task_id: frontTask,
      file_paths: ['frontend/src/App.tsx', 'FRONTEND\\src\\app.tsx', 'package.json'] });
    assert.equal(successful.acquired, true);
    assert.equal(successful.reservations.length, 2);
    const denied = f.files.reserve({ agent_id: 'cursor-backend', task_id: backTask, file_path: 'PACKAGE.JSON' });
    assert.equal(denied.acquired, false);
    assert.equal(denied.conflicts[0].type, 'ACTIVE_WRITE_RESERVATION');
    assert.equal(f.files.status().agents_editing_shared_areas.length, 1);
    const beforeCount = f.core.listAudit({ entity_type: 'file_reservation' }).length;
    assert.throws(() => f.files.reserveBatch({ agent_id: 'cursor-backend', task_id: backTask,
      file_paths: ['backend/src/okay.ts', '../outside.ts'] }), /invalid|parent-directory/);
    assert.equal(f.files.listReservations({ task_id: backTask }).length, 0);
    assert.equal(f.core.listAudit({ entity_type: 'file_reservation' }).length, beforeCount);
  } finally { f.close(); }
});

test('shared reads coexist, exclusive writes wait, and rejected approval needs a reason', () => {
  const f = fixture();
  try {
    const backendTask = f.task('cursor-backend');
    const frontendTask = f.task('antigravity-frontend');
    const first = f.files.reserve({ agent_id: 'cursor-backend', task_id: backendTask,
      file_path: 'package.json', reservation_type: 'shared_read' });
    const second = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: 'PACKAGE.JSON', reservation_type: 'shared_read' });
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.equal(f.files.status().agents_editing_shared_areas.length, 0);
    const write = f.files.reserve({ agent_id: 'cursor-backend', task_id: backendTask,
      file_path: 'package.json', reservation_type: 'exclusive_write' });
    assert.equal(write.acquired, false);
    assert.equal(write.conflicts[0].type, 'ACTIVE_READ_RESERVATION');
    const ownership = f.files.requestOwnership({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: 'backend/src/api.ts', reason: 'Need endpoint', expected_changes: 'Add route' });
    assert.throws(() => f.files.respondOwnership({ agent_id: 'cursor-backend', ownership_request_id: ownership.id,
      decision: 'rejected', response_message: '' }), /reason/);
    assert.equal(f.files.respondOwnership({ agent_id: 'cursor-backend', ownership_request_id: ownership.id,
      decision: 'rejected', response_message: 'Backend task will handle it' }).status, 'rejected');
  } finally { f.close(); }
});

test('lease renewal, expiration, stale writer warning, scoped approval expiration, and release authorization', () => {
  const f = fixture({ leaseSeconds: 30, maxLeaseSeconds: 60, approvalSeconds: 30 });
  try {
    const backendTask = f.task('cursor-backend');
    const frontendTask = f.task('antigravity-frontend');
    const target = 'backend/src/api.ts';
    const own = f.files.reserve({ agent_id: 'cursor-backend', task_id: backendTask, file_path: target }).reservations[0];
    assert.throws(() => f.files.renew({ agent_id: 'antigravity-frontend', reservation_id: own.id }), /holder/);
    assert.throws(() => f.files.release({ agent_id: 'antigravity-frontend', reservation_id: own.id, release_reason: 'No' }), /holder/);
    assert.throws(() => f.files.renew({ agent_id: 'cursor-backend', reservation_id: own.id, requested_duration_seconds: 61 }), /maximum/);
    const renewed = f.files.renew({ agent_id: 'cursor-backend', reservation_id: own.id, requested_duration_seconds: 60 });
    assert.ok(renewed.renewed_at);
    const request = f.files.requestOwnership({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: target, reason: 'Need API change', expected_changes: 'Add field' });
    f.files.respondOwnership({ agent_id: 'cursor-backend', ownership_request_id: request.id,
      decision: 'approved', response_message: 'Okay' });
    f.core.db.prepare("UPDATE ownership_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(request.id);
    assert.equal(f.files.ownershipCheck({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target }).ownership_allowed, false);
    f.core.db.prepare("UPDATE file_reservations SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?").run(own.id);
    assert.throws(() => f.files.renew({ agent_id: 'cursor-backend', reservation_id: own.id }), /live active/);
    const denied = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(denied.acquired, false);
    assert.equal(f.files.reservation(own.id).status, 'expired');
    assert.equal(f.files.release({ agent_id: 'cursor-backend', reservation_id: own.id, release_reason: 'Expired' }).status, 'expired');
    assert.equal(f.files.ownershipRequest(request.id).status, 'expired');
    const next = f.files.requestOwnership({ agent_id: 'antigravity-frontend', task_id: frontendTask,
      file_path: target, reason: 'Renew permission', expected_changes: 'Add field' });
    f.files.respondOwnership({ agent_id: 'cursor-backend', ownership_request_id: next.id,
      decision: 'approved', response_message: 'Okay' });
    const result = f.files.reserve({ agent_id: 'antigravity-frontend', task_id: frontendTask, file_path: target });
    assert.equal(result.acquired, true);
    assert.match(result.stale_writer_warning[0], /Previous lease held by cursor-backend expired/);
    assert.throws(() => f.files.renew({ agent_id: 'cursor-backend', reservation_id: own.id }), /live active/);
  } finally { f.close(); }
});
