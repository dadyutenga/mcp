import { randomUUID } from 'node:crypto';
import { projectRoot } from './db.js';
import { loadPolicy, normalizeFilePath, policyOwner } from './paths.js';

const fail = message => { throw new Error(message); };
const sqlNow = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const leaseSql = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' seconds')`;

export class FileCoordination {
  constructor(core, { root = projectRoot(), policy = loadPolicy() } = {}) {
    this.core = core;
    this.db = core.db;
    this.root = root;
    this.policy = policy;
  }
  clock(duration) {
    return this.db.prepare(`SELECT ${sqlNow} AS now, ${leaseSql} AS expires`).get(duration);
  }
  path(filePath) { return normalizeFilePath(filePath, this.root); }
  taskFor(agentId, taskId) {
    this.core.requireAgent(agentId);
    const task = this.core.requireTask(taskId);
    if (task.claimed_by_agent_id !== agentId || !['in_progress', 'blocked'].includes(task.status)) {
      fail('Agent must claim an active task before reserving files');
    }
    return task;
  }
  reservation(id) { return this.db.prepare('SELECT * FROM file_reservations WHERE id=?').get(id) ?? null; }
  ownershipRequest(id) { return this.db.prepare('SELECT * FROM ownership_requests WHERE id=?').get(id) ?? null; }
  active(pathKey, time) {
    return this.db.prepare(`SELECT * FROM file_reservations WHERE normalized_path=? AND status='active'
      AND expires_at>? ORDER BY acquired_at, id`).all(pathKey, time);
  }
  approval(agentId, taskId, pathKey, owner, time) {
    return this.db.prepare(`SELECT * FROM ownership_requests WHERE requesting_agent_id=? AND task_id=?
      AND normalized_path=? AND owning_agent_id=? AND status='approved' AND expires_at>? ORDER BY updated_at DESC LIMIT 1`)
      .get(agentId, taskId, pathKey, owner, time) ?? null;
  }
  evaluate(agentId, taskId, pathInfo, type, time) {
    const owner = policyOwner(this.policy, pathInfo.normalized_path);
    const approval = owner !== 'shared' && owner !== agentId ? this.approval(agentId, taskId, pathInfo.normalized_path, owner, time) : null;
    const ownershipAllowed = type === 'shared_read' || owner === 'shared' || owner === agentId || !!approval;
    const active = this.active(pathInfo.normalized_path, time);
    const conflicts = [];
    for (const row of active) {
      if (row.agent_id === agentId && row.task_id === taskId && row.reservation_type === type) continue;
      if (type === 'exclusive_write' || row.reservation_type === 'exclusive_write') {
        conflicts.push({ type: row.reservation_type === 'exclusive_write' ? 'ACTIVE_WRITE_RESERVATION' : 'ACTIVE_READ_RESERVATION',
          severity: 'critical', file_path: pathInfo.repository_path, normalized_path: pathInfo.normalized_path,
          conflicting_agent_id: row.agent_id, conflicting_task_id: row.task_id, reservation_id: row.id,
          description: `File reserved by ${row.agent_id} until ${row.expires_at}. Release or wait before editing.`,
          required_next_action: 'Wait for release or lease expiry, then reserve again. Verify the previous editor stopped.' });
      }
    }
    if (!ownershipAllowed) conflicts.push({ type: 'OWNERSHIP_VIOLATION', severity: 'critical',
      file_path: pathInfo.repository_path, normalized_path: pathInfo.normalized_path,
      conflicting_agent_id: owner, conflicting_task_id: null, reservation_id: null,
      description: `Policy owner is ${owner}; ${agentId} needs scoped approval for this task and file.`,
      required_next_action: 'Use file_ownership_request or ask the owner to take a linked task.' });
    const duplicate = active.find(row => row.agent_id === agentId && row.task_id === taskId && row.reservation_type === type);
    return { normalized_path: pathInfo.normalized_path, repository_path: pathInfo.repository_path,
      policy_owner: owner, requesting_agent: agentId, ownership_allowed: ownershipAllowed,
      approval_id: approval?.id ?? null, active_reservations: active, detected_conflicts: conflicts,
      required_next_action: conflicts.length ? conflicts.map(x => x.required_next_action).join(' ') :
        duplicate ? 'Reservation already held; renew it if needed.' : 'Acquire a reservation before editing.', duplicate };
  }
  ownershipCheck({ agent_id, file_path, task_id }) {
    this.core.requireAgent(agent_id);
    if (task_id) this.core.requireTask(task_id);
    const item = this.evaluate(agent_id, task_id ?? null, this.path(file_path), 'exclusive_write', this.clock(1).now);
    const { duplicate, ...report } = item;
    return report;
  }
  conflictCheck({ agent_id, task_id, file_paths }) {
    this.taskFor(agent_id, task_id);
    const time = this.clock(1).now;
    const paths = this.canonicalPaths(file_paths);
    const reports = paths.map(item => this.evaluate(agent_id, task_id, item, 'exclusive_write', time));
    const conflicts = reports.flatMap(x => x.detected_conflicts);
    return { safe_to_proceed: conflicts.length === 0, reservation_granted: false,
      checked_files: reports.map(({ duplicate, ...rest }) => rest),
      conflicting_files: [...new Set(conflicts.map(x => x.normalized_path))],
      conflicting_agents: [...new Set(conflicts.map(x => x.conflicting_agent_id).filter(Boolean))],
      reservation_ids: [...new Set(conflicts.map(x => x.reservation_id).filter(Boolean))],
      ownership_policy_violations: conflicts.filter(x => x.type === 'OWNERSHIP_VIOLATION'),
      severity: conflicts.length ? 'critical' : 'none',
      recommended_actions: conflicts.length ? [...new Set(conflicts.map(x => x.required_next_action))] :
        ['Acquire file_reserve_batch before editing; this read-only check grants no reservation.'] };
  }
  canonicalPaths(filePaths) {
    if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 100) fail('Provide 1–100 file paths');
    const unique = new Map();
    for (const filePath of filePaths) {
      const result = this.path(filePath);
      if (!unique.has(result.normalized_path)) unique.set(result.normalized_path, result);
    }
    return [...unique.values()].sort((a, b) => a.normalized_path.localeCompare(b.normalized_path, 'en'));
  }
  expireLeases(time) {
    const rows = this.db.prepare(`SELECT * FROM file_reservations WHERE status='active' AND expires_at<=?`).all(time);
    for (const row of rows) {
      this.db.prepare(`UPDATE file_reservations SET status='expired', updated_at=? WHERE id=?`).run(time, row.id);
      this.core.audit(row.agent_id, 'file_reservation', row.id, 'expired', row, this.reservation(row.id));
      this.resolveReservationConflicts(row.id, 'Reservation lease expired', time);
    }
    return rows;
  }
  expireApprovals(time) {
    const rows = this.db.prepare(`SELECT * FROM ownership_requests WHERE status='approved' AND expires_at<=?`).all(time);
    for (const row of rows) {
      this.db.prepare(`UPDATE ownership_requests SET status='expired', updated_at=? WHERE id=?`).run(time, row.id);
      this.core.audit(row.owning_agent_id, 'ownership_request', row.id, 'expired', row, this.ownershipRequest(row.id));
    }
  }
  staleWriters(paths) {
    const cutoff = this.db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AS cutoff`).get().cutoff;
    const results = [];
    for (const item of paths) {
      const rows = this.db.prepare(`SELECT DISTINCT agent_id FROM file_reservations
        WHERE normalized_path=? AND status='expired' AND expires_at>=?`).all(item.normalized_path, cutoff);
      for (const row of rows) results.push(`Previous lease held by ${row.agent_id} expired for ${item.normalized_path}; verify that editor stopped.`);
    }
    return results;
  }
  resolveReservationConflicts(reservationId, resolution, time) {
    const rows = this.db.prepare('SELECT * FROM file_conflicts WHERE conflicting_reservation_id=? AND resolved_at IS NULL').all(reservationId);
    for (const row of rows) {
      this.db.prepare('UPDATE file_conflicts SET resolved_at=?, resolution=? WHERE id=?').run(time, resolution, row.id);
      this.core.audit(row.conflicting_agent_id, 'file_conflict', row.id, 'resolved', row,
        this.db.prepare('SELECT * FROM file_conflicts WHERE id=?').get(row.id));
    }
  }
  recordConflict(agentId, taskId, conflict, time) {
    const existing = this.db.prepare(`SELECT * FROM file_conflicts WHERE requesting_agent_id=? AND requesting_task_id=?
      AND normalized_path=? AND conflict_type=? AND conflicting_agent_id IS ?
      AND conflicting_reservation_id IS ? AND resolved_at IS NULL LIMIT 1`)
      .get(agentId, taskId, conflict.normalized_path, conflict.type,
        this.core.getAgent(conflict.conflicting_agent_id) ? conflict.conflicting_agent_id : null, conflict.reservation_id);
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO file_conflicts (id,requesting_agent_id,conflicting_agent_id,normalized_path,
      requesting_task_id,conflicting_task_id,conflicting_reservation_id,conflict_type,severity,description,
      created_at,resolved_at,resolution,notification_message_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`)
      .run(id, agentId, this.core.getAgent(conflict.conflicting_agent_id) ? conflict.conflicting_agent_id : null, conflict.normalized_path, taskId,
        conflict.conflicting_task_id, conflict.reservation_id, conflict.type, conflict.severity, conflict.description, time);
    let messageId = null;
    if (conflict.conflicting_agent_id && conflict.conflicting_agent_id !== agentId && this.core.getAgent(conflict.conflicting_agent_id)) {
      const message = this.core.sendMessage({ sender_agent_id: agentId, recipient_agent_id: conflict.conflicting_agent_id,
        task_id: taskId, message_type: 'blocker', subject: 'File ownership conflict',
        body: `File: ${conflict.normalized_path}\nTask: ${taskId}\nConflict: ${conflict.type}\nAction: ${conflict.required_next_action}` });
      messageId = message.id;
      this.db.prepare('UPDATE file_conflicts SET notification_message_id=? WHERE id=?').run(messageId, id);
    }
    const after = this.db.prepare('SELECT * FROM file_conflicts WHERE id=?').get(id);
    this.core.audit(agentId, 'file_conflict', id, 'detected', null, after);
    return after;
  }
  reserve({ agent_id, file_path, task_id, reservation_type = 'exclusive_write', reason = '' }) {
    return this.reserveBatch({ agent_id, file_paths: [file_path], task_id, reservation_type, reason });
  }
  reserveBatch({ agent_id, file_paths, task_id, reservation_type = 'exclusive_write', reason = '' }) {
    if (!['exclusive_write', 'shared_read'].includes(reservation_type)) fail('Invalid reservation type');
    const paths = this.canonicalPaths(file_paths);
    return this.core.tx(() => {
      this.taskFor(agent_id, task_id);
      const clock = this.clock(this.policy.leaseSeconds);
      this.expireLeases(clock.now);
      this.expireApprovals(clock.now);
      const reports = paths.map(item => this.evaluate(agent_id, task_id, item, reservation_type, clock.now));
      const conflicts = reports.flatMap(report => report.detected_conflicts);
      if (conflicts.length) {
        for (const conflict of conflicts) this.recordConflict(agent_id, task_id, conflict, clock.now);
        return { acquired: false, reservations: [], conflicts,
          message: `Reservation denied: ${conflicts.map(x => x.description).join(' ')}` };
      }
      const reservations = [];
      for (const report of reports) {
        if (report.duplicate) { reservations.push(report.duplicate); continue; }
        const id = randomUUID();
        this.db.prepare(`INSERT INTO file_reservations (id,repository_path,normalized_path,agent_id,task_id,
          reservation_type,status,acquired_at,expires_at,renewed_at,released_at,release_reason,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'active',?,?,NULL,NULL,NULL,?,?)`)
          .run(id, report.repository_path, report.normalized_path, agent_id, task_id, reservation_type,
            clock.now, clock.expires, clock.now, clock.now);
        const after = this.reservation(id);
        this.core.audit(agent_id, 'file_reservation', id, 'acquired', null, { ...after, reason });
        reservations.push(after);
      }
      return { acquired: true, reservations, conflicts: [],
        stale_writer_warning: this.staleWriters(paths),
        message: 'Reservation acquired. Edit only while the lease remains active.' };
    });
  }
  listReservations({ agent_id = null, task_id = null, status = null, file_path = null, limit = 100 } = {}) {
    const key = file_path ? this.path(file_path).normalized_path : null;
    const time = this.clock(1).now;
    return this.db.prepare(`SELECT *, CASE WHEN status='active' AND expires_at<=? THEN 'expired' ELSE status END AS effective_status
      FROM file_reservations WHERE (? IS NULL OR agent_id=?) AND (? IS NULL OR task_id=?)
      AND (? IS NULL OR normalized_path=?) AND (? IS NULL OR (CASE WHEN status='active' AND expires_at<=? THEN 'expired' ELSE status END)=?)
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(time, agent_id, agent_id, task_id, task_id, key, key, status, time, status, limit);
  }
  renew({ agent_id, reservation_id, requested_duration_seconds }) {
    return this.core.tx(() => {
      this.core.requireAgent(agent_id);
      const before = this.reservation(reservation_id) || fail(`Unknown reservation: ${reservation_id}`);
      if (before.agent_id !== agent_id) fail('Only the holder can renew this reservation');
      this.taskFor(agent_id, before.task_id);
      const duration = requested_duration_seconds ?? this.policy.leaseSeconds;
      if (!Number.isInteger(duration) || duration < 1 || duration > this.policy.maxLeaseSeconds) fail('Requested lease duration exceeds policy maximum');
      const clock = this.clock(duration);
      if (before.status !== 'active' || before.expires_at <= clock.now) fail('Only a live active reservation can be renewed');
      this.db.prepare('UPDATE file_reservations SET expires_at=?, renewed_at=?, updated_at=? WHERE id=?')
        .run(clock.expires, clock.now, clock.now, reservation_id);
      const after = this.reservation(reservation_id);
      this.core.audit(agent_id, 'file_reservation', reservation_id, 'renewed', before, after);
      return after;
    });
  }
  release({ agent_id, reservation_id, release_reason }) {
    return this.core.tx(() => {
      this.core.requireAgent(agent_id);
      const before = this.reservation(reservation_id) || fail(`Unknown reservation: ${reservation_id}`);
      if (before.agent_id !== agent_id) fail('Only the holder can release this reservation');
      if (before.status !== 'active') return before;
      const time = this.clock(1).now;
      const nextStatus = before.expires_at <= time ? 'expired' : 'released';
      this.db.prepare(`UPDATE file_reservations SET status=?, released_at=?, release_reason=?, updated_at=? WHERE id=?`)
        .run(nextStatus, time, release_reason, time, reservation_id);
      const after = this.reservation(reservation_id);
      this.core.audit(agent_id, 'file_reservation', reservation_id, nextStatus === 'released' ? 'released' : 'expired', before, after);
      this.resolveReservationConflicts(reservation_id, `Reservation ${nextStatus}`, time);
      return after;
    });
  }
  listConflicts({ agent_id = null, task_id = null, status = null, severity = null, limit = 100 } = {}) {
    return this.db.prepare(`SELECT *, CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status
      FROM file_conflicts WHERE (? IS NULL OR requesting_agent_id=? OR conflicting_agent_id=?)
      AND (? IS NULL OR requesting_task_id=? OR conflicting_task_id=?)
      AND (? IS NULL OR (CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END)=?)
      AND (? IS NULL OR severity=?) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(agent_id, agent_id, agent_id, task_id, task_id, task_id, status, status, severity, severity, limit);
  }
  requestOwnership({ agent_id, file_path, task_id, reason, expected_changes }) {
    const pathInfo = this.path(file_path);
    return this.core.tx(() => {
      this.taskFor(agent_id, task_id);
      const owner = policyOwner(this.policy, pathInfo.normalized_path);
      if (owner === 'shared' || owner === agent_id) fail('This file does not need another agent’s ownership approval');
      this.core.requireAgent(owner);
      const existing = this.db.prepare(`SELECT * FROM ownership_requests WHERE requesting_agent_id=? AND normalized_path=?
        AND task_id=? AND status='pending' LIMIT 1`).get(agent_id, pathInfo.normalized_path, task_id);
      if (existing) return existing;
      const time = this.clock(1).now, id = randomUUID();
      this.db.prepare(`INSERT INTO ownership_requests (id,requesting_agent_id,owning_agent_id,normalized_path,
        task_id,reason,expected_changes,status,response_message,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL,?,?)`)
        .run(id, agent_id, owner, pathInfo.normalized_path, task_id, reason, expected_changes, time, time);
      const message = this.core.sendMessage({ sender_agent_id: agent_id, recipient_agent_id: owner, task_id,
        message_type: 'question', subject: 'File ownership approval requested',
        body: `File: ${pathInfo.normalized_path}\nTask: ${task_id}\nAction: Review ownership request ${id} with file_ownership_request_list. Approval permits a reservation request; it does not override an active lease.` });
      const after = this.ownershipRequest(id);
      this.core.audit(agent_id, 'ownership_request', id, 'requested', null, { ...after, notification_message_id: message.id });
      return after;
    });
  }
  respondOwnership({ agent_id, ownership_request_id, decision, response_message }) {
    return this.core.tx(() => {
      this.core.requireAgent(agent_id);
      const before = this.ownershipRequest(ownership_request_id) || fail(`Unknown ownership request: ${ownership_request_id}`);
      if (before.owning_agent_id !== agent_id) fail('Only the policy owner can respond');
      if (policyOwner(this.policy, before.normalized_path) !== agent_id) fail('Ownership policy changed; create a new request for the current owner');
      if (before.status !== 'pending') fail(`Request is already ${before.status}`);
      if (!['approved', 'rejected'].includes(decision)) fail('Decision must be approved or rejected');
      if (decision === 'rejected' && !response_message?.trim()) fail('Rejection requires a reason');
      const clock = this.clock(this.policy.approvalSeconds);
      this.db.prepare(`UPDATE ownership_requests SET status=?, response_message=?, expires_at=?, updated_at=? WHERE id=?`)
        .run(decision, response_message ?? null, decision === 'approved' ? clock.expires : null, clock.now, ownership_request_id);
      const after = this.ownershipRequest(ownership_request_id);
      this.core.audit(agent_id, 'ownership_request', ownership_request_id, decision, before, after);
      if (decision === 'approved') {
        const conflicts = this.db.prepare(`SELECT * FROM file_conflicts WHERE requesting_agent_id=? AND requesting_task_id=?
          AND normalized_path=? AND conflict_type='OWNERSHIP_VIOLATION' AND resolved_at IS NULL`)
          .all(before.requesting_agent_id, before.task_id, before.normalized_path);
        for (const conflict of conflicts) {
          this.db.prepare('UPDATE file_conflicts SET resolved_at=?, resolution=? WHERE id=?')
            .run(clock.now, `Approved by ${agent_id}`, conflict.id);
          this.core.audit(agent_id, 'file_conflict', conflict.id, 'resolved', conflict,
            this.db.prepare('SELECT * FROM file_conflicts WHERE id=?').get(conflict.id));
        }
      }
      this.core.sendMessage({ sender_agent_id: agent_id, recipient_agent_id: before.requesting_agent_id,
        task_id: before.task_id, message_type: 'resolution', subject: `File ownership request ${decision}`,
        body: `File: ${before.normalized_path}\nRequest: ${ownership_request_id}\nDecision: ${decision}\n${decision === 'approved' ? `Approval expires: ${clock.expires}. Acquire a separate reservation before editing.` : 'Review the response in file_ownership_request_list and coordinate the next task.'}` });
      return after;
    });
  }
  listOwnershipRequests({ agent_id = null, status = null, limit = 100 } = {}) {
    const time = this.clock(1).now;
    return this.db.prepare(`SELECT *, CASE WHEN status='approved' AND expires_at<=? THEN 'expired' ELSE status END AS effective_status
      FROM ownership_requests WHERE (? IS NULL OR requesting_agent_id=? OR owning_agent_id=?)
      AND (? IS NULL OR (CASE WHEN status='approved' AND expires_at<=? THEN 'expired' ELSE status END)=?)
      ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(time, agent_id, agent_id, agent_id, status, time, status, limit);
  }
  status() {
    const time = this.clock(1).now;
    const active = this.listReservations({ status: 'active', limit: 500 });
    const conflicts = this.listConflicts({ status: 'open', limit: 500 });
    const pending = this.db.prepare(`SELECT * FROM ownership_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 500`).all();
    const expired = this.listReservations({ status: 'expired', limit: 500 });
    return { active_reservations: active, ownership_violations: conflicts.filter(x => x.conflict_type === 'OWNERSHIP_VIOLATION'),
      open_conflicts: conflicts, pending_ownership_approvals: pending, expired_leases: expired,
      agents_editing_shared_areas: active.filter(x => x.reservation_type === 'exclusive_write' &&
        policyOwner(this.policy, x.normalized_path) === 'shared'),
      tasks_blocked_by_file_conflicts: [...new Set(conflicts.filter(x => x.severity === 'critical').map(x => x.requesting_task_id))],
      checked_at: time };
  }
}
