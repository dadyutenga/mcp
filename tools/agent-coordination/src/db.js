import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function projectRoot() {
  const root = path.resolve(process.env.AGENT_COORDINATION_PROJECT_ROOT || defaultRoot);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Project root is not an existing directory: ${root}`);
  }
  return root;
}

export function databasePath() {
  return path.join(projectRoot(), '.local', 'agent-coordination', 'coordination.sqlite');
}

export const migrations = [
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('backend', 'frontend', 'other')),
    capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata))
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    creator_agent_id TEXT NOT NULL REFERENCES agents(id),
    assignee_agent_id TEXT REFERENCES agents(id),
    claimed_by_agent_id TEXT REFERENCES agents(id),
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
    status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
    progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
    acceptance_criteria TEXT NOT NULL CHECK (json_valid(acceptance_criteria)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    completion_details TEXT,
    verification_evidence TEXT,
    blockers TEXT NOT NULL CHECK (json_valid(blockers))
  );
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender_agent_id TEXT NOT NULL REFERENCES agents(id),
    recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
    task_id TEXT REFERENCES tasks(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('info', 'question', 'handoff', 'blocker', 'resolution')),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  );
  CREATE TABLE change_requests (
    id TEXT PRIMARY KEY,
    requester_agent_id TEXT NOT NULL REFERENCES agents(id),
    recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
    linked_task_id TEXT REFERENCES tasks(id),
    affected_files TEXT NOT NULL CHECK (json_valid(affected_files)),
    current_behavior TEXT NOT NULL,
    expected_behavior TEXT NOT NULL,
    rationale TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL CHECK (json_valid(acceptance_criteria)),
    compatibility_impact TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
    response_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    actor_agent_id TEXT REFERENCES agents(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    previous_state TEXT CHECK (previous_state IS NULL OR json_valid(previous_state)),
    new_state TEXT CHECK (new_state IS NULL OR json_valid(new_state)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_agents_role ON agents(role);
  CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_agent_id, status);
  CREATE INDEX idx_tasks_claimed_status ON tasks(claimed_by_agent_id, status);
  CREATE INDEX idx_tasks_status_priority ON tasks(status, priority DESC, created_at);
  CREATE INDEX idx_task_dependencies_depends ON task_dependencies(depends_on_task_id);
  CREATE INDEX idx_messages_recipient ON messages(recipient_agent_id, acknowledged_at, created_at);
  CREATE INDEX idx_messages_task ON messages(task_id, created_at);
  CREATE INDEX idx_change_requests_recipient ON change_requests(recipient_agent_id, status, created_at);
  CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
  CREATE INDEX idx_audit_actor ON audit_events(actor_agent_id, created_at);`,
  `CREATE TABLE file_reservations (
    id TEXT PRIMARY KEY,
    repository_path TEXT NOT NULL,
    normalized_path TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    reservation_type TEXT NOT NULL CHECK (reservation_type IN ('exclusive_write', 'shared_read')),
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    renewed_at TEXT,
    released_at TEXT,
    release_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE file_conflicts (
    id TEXT PRIMARY KEY,
    requesting_agent_id TEXT NOT NULL REFERENCES agents(id),
    conflicting_agent_id TEXT REFERENCES agents(id),
    normalized_path TEXT NOT NULL,
    requesting_task_id TEXT NOT NULL REFERENCES tasks(id),
    conflicting_task_id TEXT REFERENCES tasks(id),
    conflicting_reservation_id TEXT REFERENCES file_reservations(id),
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('ACTIVE_WRITE_RESERVATION', 'ACTIVE_READ_RESERVATION', 'OWNERSHIP_VIOLATION')),
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    notification_message_id TEXT REFERENCES messages(id)
  );
  CREATE TABLE ownership_requests (
    id TEXT PRIMARY KEY,
    requesting_agent_id TEXT NOT NULL REFERENCES agents(id),
    owning_agent_id TEXT NOT NULL REFERENCES agents(id),
    normalized_path TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    reason TEXT NOT NULL,
    expected_changes TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
    response_message TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_file_reservations_path ON file_reservations(normalized_path, status, expires_at);
  CREATE INDEX idx_file_reservations_agent ON file_reservations(agent_id, status, task_id);
  CREATE INDEX idx_file_reservations_task ON file_reservations(task_id, status);
  CREATE UNIQUE INDEX idx_file_reservation_duplicate ON file_reservations(normalized_path, agent_id, task_id, reservation_type) WHERE status='active';
  CREATE INDEX idx_file_conflicts_requester ON file_conflicts(requesting_agent_id, resolved_at, severity);
  CREATE INDEX idx_file_conflicts_task ON file_conflicts(requesting_task_id, resolved_at);
  CREATE INDEX idx_file_conflicts_path ON file_conflicts(normalized_path, resolved_at);
  CREATE INDEX idx_ownership_requests_scope ON ownership_requests(requesting_agent_id, normalized_path, task_id, status, expires_at);
  CREATE INDEX idx_ownership_requests_owner ON ownership_requests(owning_agent_id, status, created_at);`
];

const pause = new Int32Array(new SharedArrayBuffer(4));
function retryBusy(action) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return action(); }
    catch (error) {
      if (!/^SQLITE_(BUSY|LOCKED)/.test(error.code ?? '') || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 50);
    }
  }
}

export function openDatabase(file = databasePath()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    retryBusy(() => {
      if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    });
    db.pragma('foreign_keys = ON');
    retryBusy(() => db.transaction(() => {
      const version = db.pragma('user_version', { simple: true });
      if (version > migrations.length) throw new Error(`Database schema version ${version} is newer than this service supports`);
      for (let i = version; i < migrations.length; i++) {
        db.exec(migrations[i]);
        db.pragma(`user_version = ${i + 1}`);
      }
    }).immediate());
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
