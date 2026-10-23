import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);
const fail = (message) => { throw new Error(message); };

function hydrate(row, fields) {
  if (!row) return null;
  const result = { ...row };
  for (const field of fields) result[field] = parse(result[field]);
  return result;
}
const agent = (row) => hydrate(row, ['capabilities', 'metadata']);
const task = (row) => hydrate(row, ['acceptance_criteria', 'blockers']);
const request = (row) => hydrate(row, ['affected_files', 'acceptance_criteria']);
const auditEvent = (row) => hydrate(row, ['previous_state', 'new_state']);

export class Coordination {
  constructor(db = openDatabase()) { this.db = db; }
  close() { this.db.close(); }
  tx(fn) { return this.db.transaction(fn).immediate(); }
  audit(actorId, entityType, entityId, action, before, after) {
    this.db.prepare(`INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), actorId, entityType, entityId, action,
      before == null ? null : json(before), after == null ? null : json(after), now()
    );
  }
  requireAgent(id) { return this.getAgent(id) || fail(`Unknown agent: ${id}`); }
  getAgent(id) { return agent(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id)); }
  listAgents(role) {
    return this.db.prepare(`SELECT * FROM agents WHERE (? IS NULL OR role = ?) ORDER BY registered_at, id`)
      .all(role ?? null, role ?? null).map(agent);
  }
  registerAgent(input) {
    return this.tx(() => {
      const before = this.getAgent(input.id);
      if (before && before.role !== input.role) fail('An existing agent cannot change role');
      const timestamp = now();
      this.db.prepare(`INSERT INTO agents (id, display_name, role, capabilities, registered_at, last_seen_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
          capabilities=excluded.capabilities, last_seen_at=excluded.last_seen_at, metadata=excluded.metadata`)
        .run(input.id, input.display_name, input.role, json(input.capabilities ?? []), timestamp, timestamp, json(input.metadata ?? {}));
      const after = this.getAgent(input.id);
      this.audit(input.id, 'agent', input.id, before ? 'reregistered' : 'registered', before, after);
      return after;
    });
  }
  heartbeat(id) {
    return this.tx(() => {
      const before = this.requireAgent(id);
      this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now(), id);
      const after = this.getAgent(id);
      this.audit(id, 'agent', id, 'heartbeat', before, after);
      return after;
    });
  }
  getTask(id) {
    const result = task(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    if (result) result.dependencies = this.db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id').all(id).map(x => x.depends_on_task_id);
    return result;
  }
  requireTask(id) { return this.getTask(id) || fail(`Unknown task: ${id}`); }
  listTasks({ agent_id = null, status = null, limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR creator_agent_id = ? OR assignee_agent_id = ? OR claimed_by_agent_id = ?)
      ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      priority DESC, created_at DESC LIMIT ?`).all(status, status, agent_id, agent_id, agent_id, agent_id, limit);
    return rows.map(x => this.getTask(x.id));
  }
  createTask(input) {
    return this.tx(() => {
      this.requireAgent(input.creator_agent_id);
      if (input.assignee_agent_id) this.requireAgent(input.assignee_agent_id);
      const id = randomUUID(), timestamp = now();
      this.db.prepare(`INSERT INTO tasks (id,title,description,creator_agent_id,assignee_agent_id,
        claimed_by_agent_id,priority,status,progress,acceptance_criteria,created_at,updated_at,
        claimed_at,completed_at,completion_details,verification_evidence,blockers)
        VALUES (?,?,?,?,?,NULL,?,'open',0,?,?,?,NULL,NULL,NULL,NULL,'[]')`)
        .run(id, input.title, input.description, input.creator_agent_id, input.assignee_agent_id ?? null,
          input.priority ?? 3, json(input.acceptance_criteria ?? []), timestamp, timestamp);
      const after = this.getTask(id);
      this.audit(input.creator_agent_id, 'task', id, 'created', null, after);
      return after;
    });
  }
  assignTask({ task_id, actor_agent_id, assignee_agent_id }) {
    return this.tx(() => {
      const before = this.requireTask(task_id);
      this.requireAgent(actor_agent_id);
      this.requireAgent(assignee_agent_id);
      if (before.creator_agent_id !== actor_agent_id) fail('Only the task creator can assign it');
      if (before.claimed_by_agent_id && before.claimed_by_agent_id !== assignee_agent_id) fail('A claimed task cannot be reassigned');
      if (['completed', 'cancelled'].includes(before.status)) fail('A closed task cannot be assigned');
      this.db.prepare('UPDATE tasks SET assignee_agent_id = ?, updated_at = ? WHERE id = ?').run(assignee_agent_id, now(), task_id);
      const after = this.getTask(task_id);
      this.audit(actor_agent_id, 'task', task_id, 'assigned', before, after);
      return after;
    });
  }
  claimTask({ task_id, agent_id }) {
    return this.tx(() => {
      const before = this.requireTask(task_id);
      this.requireAgent(agent_id);
      if (before.claimed_by_agent_id === agent_id) return before;
      if (before.claimed_by_agent_id) fail(`Task already claimed by ${before.claimed_by_agent_id}`);
      if (before.assignee_agent_id && before.assignee_agent_id !== agent_id) fail(`Task assigned to ${before.assignee_agent_id}`);
      if (before.status !== 'open') fail(`Task cannot be claimed in status ${before.status}`);
      const timestamp = now();
      const changed = this.db.prepare(`UPDATE tasks SET claimed_by_agent_id=?, assignee_agent_id=?,
        status='in_progress', claimed_at=?, updated_at=? WHERE id=? AND claimed_by_agent_id IS NULL AND status='open'`)
        .run(agent_id, agent_id, timestamp, timestamp, task_id).changes;
      if (changed !== 1) fail('Task claim conflict');
      const after = this.getTask(task_id);
      this.audit(agent_id, 'task', task_id, 'claimed', before, after);
      return after;
    });
  }
  updateTask(input) {
    return this.tx(() => {
      const before = this.requireTask(input.task_id);
      this.requireAgent(input.actor_agent_id);
      if (![before.creator_agent_id, before.claimed_by_agent_id].includes(input.actor_agent_id)) fail('Only the creator or claimant can update this task');
      if (['completed', 'cancelled'].includes(before.status)) fail('A closed task cannot be updated');
      if (input.status && !['in_progress', 'blocked', 'cancelled'].includes(input.status)) fail('Invalid update status');
      if (input.status === 'cancelled' && input.actor_agent_id !== before.creator_agent_id) fail('Only the creator can cancel a task');
      if (input.status === 'in_progress' && !before.claimed_by_agent_id) fail('Claim the task before starting it');
      if ((input.status ?? before.status) === 'blocked' && !(input.blockers ?? before.blockers).length) fail('A blocked task needs at least one blocker');
      const fields = [], values = [];
      for (const field of ['title', 'description', 'priority', 'progress', 'status']) {
        if (input[field] !== undefined) { fields.push(`${field} = ?`); values.push(input[field]); }
      }
      for (const field of ['acceptance_criteria', 'blockers']) {
        if (input[field] !== undefined) { fields.push(`${field} = ?`); values.push(json(input[field])); }
      }
      if (!fields.length) fail('No task changes supplied');
      fields.push('updated_at = ?'); values.push(now(), input.task_id);
      this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      const after = this.getTask(input.task_id);
      this.audit(input.actor_agent_id, 'task', input.task_id, 'updated', before, after);
      return after;
    });
  }
  completeTask({ task_id, agent_id, completion_details, verification_evidence }) {
    return this.tx(() => {
      const before = this.requireTask(task_id);
      this.requireAgent(agent_id);
      if (before.claimed_by_agent_id !== agent_id) fail('Only the claimant can complete this task');
      if (!['in_progress', 'blocked'].includes(before.status)) fail('Task is not active');
      if (before.blockers.length) fail('Resolve all blockers before completion');
      const incomplete = this.db.prepare(`SELECT d.depends_on_task_id FROM task_dependencies d
        JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? AND t.status<>'completed'`).all(task_id);
      if (incomplete.length) fail(`Incomplete dependencies: ${incomplete.map(x => x.depends_on_task_id).join(', ')}`);
      const critical = this.db.prepare(`SELECT count(*) AS count FROM file_conflicts
        WHERE requesting_task_id=? AND severity='critical' AND resolved_at IS NULL`).get(task_id).count;
      if (critical) fail('Resolve critical file conflicts before completing this task');
      const timestamp = now();
      this.db.prepare(`UPDATE tasks SET status='completed', progress=100, completed_at=?, updated_at=?,
        completion_details=?, verification_evidence=? WHERE id=?`)
        .run(timestamp, timestamp, completion_details, verification_evidence, task_id);
      const after = this.getTask(task_id);
      this.audit(agent_id, 'task', task_id, 'completed', before, after);
      return after;
    });
  }
  addDependency({ task_id, depends_on_task_id, actor_agent_id }) {
    return this.tx(() => {
      const before = this.requireTask(task_id);
      this.requireTask(depends_on_task_id);
      this.requireAgent(actor_agent_id);
      if (before.creator_agent_id !== actor_agent_id) fail('Only the task creator can add dependencies');
      if (['completed', 'cancelled'].includes(before.status)) fail('A closed task cannot gain dependencies');
      if (task_id === depends_on_task_id) fail('A task cannot depend on itself');
      const cycle = this.db.prepare(`WITH RECURSIVE path(id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN path p ON d.task_id=p.id
      ) SELECT 1 FROM path WHERE id=? LIMIT 1`).get(depends_on_task_id, task_id);
      if (cycle) fail('Dependency would create a cycle');
      this.db.prepare('INSERT OR IGNORE INTO task_dependencies VALUES (?, ?, ?)').run(task_id, depends_on_task_id, now());
      const after = this.getTask(task_id);
      if (after.dependencies.length !== before.dependencies.length) this.audit(actor_agent_id, 'task', task_id, 'dependency_added', before, after);
      return after;
    });
  }
  removeDependency({ task_id, depends_on_task_id, actor_agent_id }) {
    return this.tx(() => {
      const before = this.requireTask(task_id);
      this.requireAgent(actor_agent_id);
      if (before.creator_agent_id !== actor_agent_id) fail('Only the task creator can remove dependencies');
      this.db.prepare('DELETE FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?').run(task_id, depends_on_task_id);
      const after = this.getTask(task_id);
      if (after.dependencies.length !== before.dependencies.length) this.audit(actor_agent_id, 'task', task_id, 'dependency_removed', before, after);
      return after;
    });
  }
  sendMessage(input) {
    return this.tx(() => {
      this.requireAgent(input.sender_agent_id);
      this.requireAgent(input.recipient_agent_id);
      if (input.task_id) this.requireTask(input.task_id);
      const id = randomUUID();
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?, ?,NULL)').run(id, input.sender_agent_id,
        input.recipient_agent_id, input.task_id ?? null, input.message_type ?? 'info', input.subject, input.body, now());
      const after = this.getMessage(id);
      this.audit(input.sender_agent_id, 'message', id, 'sent', null, after);
      return after;
    });
  }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) ?? null; }
  listMessages({ agent_id, task_id = null, unacknowledged_only = false, limit = 100 }) {
    this.requireAgent(agent_id);
    return this.db.prepare(`SELECT * FROM messages WHERE (sender_agent_id=? OR recipient_agent_id=?)
      AND (? IS NULL OR task_id=?) AND (?=0 OR (recipient_agent_id=? AND acknowledged_at IS NULL))
      ORDER BY created_at DESC LIMIT ?`).all(agent_id, agent_id, task_id, task_id,
        unacknowledged_only ? 1 : 0, agent_id, limit);
  }
  acknowledgeMessage({ message_id, agent_id }) {
    return this.tx(() => {
      const before = this.getMessage(message_id) || fail(`Unknown message: ${message_id}`);
      this.requireAgent(agent_id);
      if (before.recipient_agent_id !== agent_id) fail('Only the recipient can acknowledge a message');
      if (before.acknowledged_at) return before;
      this.db.prepare('UPDATE messages SET acknowledged_at=? WHERE id=?').run(now(), message_id);
      const after = this.getMessage(message_id);
      this.audit(agent_id, 'message', message_id, 'acknowledged', before, after);
      return after;
    });
  }
  getChangeRequest(id) { return request(this.db.prepare('SELECT * FROM change_requests WHERE id=?').get(id)); }
  listChangeRequests({ agent_id, status = null, limit = 100 }) {
    this.requireAgent(agent_id);
    return this.db.prepare(`SELECT * FROM change_requests WHERE (requester_agent_id=? OR recipient_agent_id=?)
      AND (? IS NULL OR status=?) ORDER BY created_at DESC LIMIT ?`)
      .all(agent_id, agent_id, status, status, limit).map(request);
  }
  createChangeRequest(input) {
    return this.tx(() => {
      this.requireAgent(input.requester_agent_id);
      this.requireAgent(input.recipient_agent_id);
      if (input.linked_task_id) this.requireTask(input.linked_task_id);
      const id = randomUUID(), timestamp = now();
      this.db.prepare(`INSERT INTO change_requests VALUES (?,?,?,?,?,?,?,?,? ,?,'pending',NULL,?,?)`)
        .run(id, input.requester_agent_id, input.recipient_agent_id, input.linked_task_id ?? null,
          json(input.affected_files), input.current_behavior, input.expected_behavior,
          input.rationale, json(input.acceptance_criteria), input.compatibility_impact, timestamp, timestamp);
      const after = this.getChangeRequest(id);
      this.audit(input.requester_agent_id, 'change_request', id, 'created', null, after);
      return after;
    });
  }
  respondChangeRequest({ change_request_id, agent_id, status, response_reason }) {
    return this.tx(() => {
      const before = this.getChangeRequest(change_request_id) || fail(`Unknown change request: ${change_request_id}`);
      this.requireAgent(agent_id);
      if (before.recipient_agent_id !== agent_id) fail('Only the recipient can respond to a change request');
      if (before.status === 'pending' && !['accepted', 'rejected'].includes(status)) fail('Pending requests must be accepted or rejected');
      if (before.status === 'accepted' && status !== 'completed') fail('Accepted requests can only be completed');
      if (['rejected', 'completed'].includes(before.status)) fail('This change request is closed');
      this.db.prepare('UPDATE change_requests SET status=?, response_reason=?, updated_at=? WHERE id=?')
        .run(status, response_reason, now(), change_request_id);
      const after = this.getChangeRequest(change_request_id);
      this.audit(agent_id, 'change_request', change_request_id, status, before, after);
      return after;
    });
  }
  listAudit({ entity_type = null, entity_id = null, actor_agent_id = null, limit = 100 } = {}) {
    return this.db.prepare(`SELECT * FROM audit_events WHERE (? IS NULL OR entity_type=?)
      AND (? IS NULL OR entity_id=?) AND (? IS NULL OR actor_agent_id=?)
      ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(entity_type, entity_type, entity_id, entity_id, actor_agent_id, actor_agent_id, limit).map(auditEvent);
  }
  snapshot(agent_id) {
    this.requireAgent(agent_id);
    return {
      agent: this.getAgent(agent_id), agents: this.listAgents(), tasks: this.listTasks({ agent_id }),
      unread_messages: this.listMessages({ agent_id, unacknowledged_only: true }),
      change_requests: this.listChangeRequests({ agent_id })
    };
  }
}
