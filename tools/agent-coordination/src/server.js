import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Coordination } from './core.js';
import { FileCoordination } from './files.js';
import { registerWorkspaceTools } from './workspace-tools.js';

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1);
const shortText = text.max(500);
const strings = z.array(text).max(100);
const limit = z.number().int().min(1).max(500).optional();
const role = z.enum(['backend', 'frontend', 'other']);
const taskStatus = z.enum(['open', 'in_progress', 'blocked', 'completed', 'cancelled']);

export function createServer(core = new Coordination()) {
  const server = new McpServer({ name: 'local-agent-coordination', version: '1.1.0' });
  const files = new FileCoordination(core);
  let boundAgentId = null;
  const actor = () => boundAgentId || (() => { throw new Error('Call agent_register to bind this MCP session before a write operation'); })();
  const requireActor = id => {
    if (actor() !== id) throw new Error(`This MCP session is bound to ${boundAgentId}, not ${id}`);
    return id;
  };
  const tool = (name, description, schema, run) => server.registerTool(name, {
    description, inputSchema: schema,
  }, async (args) => {
    try {
      const data = run(schema.parse(args));
      return { content: [{ type: 'text', text: `${name} succeeded\n${JSON.stringify(data, null, 2)}` }], structuredContent: { result: data } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `${name} failed: ${error.message}` }] };
    }
  });

  tool('agent_register', 'Register or refresh a stable agent identity after an IDE restart.', z.object({
    id, display_name: shortText, role, capabilities: strings.default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }), x => {
    if (boundAgentId && boundAgentId !== x.id) throw new Error(`This MCP session is bound to ${boundAgentId}`);
    const registered = core.registerAgent(x);
    boundAgentId = x.id;
    return registered;
  });
  tool('agent_list', 'Discover registered agents and their capabilities.', z.object({ role: role.optional() }), x => core.listAgents(x.role));
  tool('agent_heartbeat', 'Update an agent last seen timestamp.', z.object({ agent_id: id }), x => core.heartbeat(requireActor(x.agent_id)));
  tool('state_snapshot', 'Recover your tasks, unread messages, change requests, and peer identities.', z.object({ agent_id: id }), x => core.snapshot(x.agent_id));

  tool('task_create', 'Create a task with acceptance criteria and optional assignee.', z.object({
    creator_agent_id: id, title: shortText, description: text, assignee_agent_id: id.optional(),
    priority: z.number().int().min(1).max(5).default(3), acceptance_criteria: strings.default([]),
  }), x => { requireActor(x.creator_agent_id); return core.createTask(x); });
  tool('task_get', 'Get a task and its dependencies.', z.object({ task_id: id }), x => core.requireTask(x.task_id));
  tool('task_list', 'List tasks, optionally filtered by involved agent and status.', z.object({
    agent_id: id.optional(), status: taskStatus.optional(), limit,
  }), x => core.listTasks(x));
  tool('task_assign', 'Assign an unclosed task; only its creator may do so.', z.object({
    task_id: id, actor_agent_id: id, assignee_agent_id: id,
  }), x => { requireActor(x.actor_agent_id); return core.assignTask(x); });
  tool('task_claim', 'Atomically claim an open task for one agent.', z.object({ task_id: id, agent_id: id }), x => { requireActor(x.agent_id); return core.claimTask(x); });
  tool('task_update', 'Update progress, blockers, status, or task details.', z.object({
    task_id: id, actor_agent_id: id, title: shortText.optional(), description: text.optional(),
    priority: z.number().int().min(1).max(5).optional(), progress: z.number().int().min(0).max(99).optional(),
    status: z.enum(['in_progress', 'blocked', 'cancelled']).optional(),
    acceptance_criteria: strings.optional(), blockers: strings.optional(),
  }), x => { requireActor(x.actor_agent_id); return core.updateTask(x); });
  tool('task_complete', 'Complete a claimed task with details and verification evidence.', z.object({
    task_id: id, agent_id: id, completion_details: text, verification_evidence: text,
  }), x => { requireActor(x.agent_id); return core.completeTask(x); });
  tool('task_dependency_add', 'Add a task dependency, rejecting dependency cycles.', z.object({
    task_id: id, depends_on_task_id: id, actor_agent_id: id,
  }), x => { requireActor(x.actor_agent_id); return core.addDependency(x); });
  tool('task_dependency_remove', 'Remove a task dependency.', z.object({
    task_id: id, depends_on_task_id: id, actor_agent_id: id,
  }), x => { requireActor(x.actor_agent_id); return core.removeDependency(x); });

  tool('message_send', 'Send a persistent message to another agent.', z.object({
    sender_agent_id: id, recipient_agent_id: id, task_id: id.optional(),
    message_type: z.enum(['info', 'question', 'handoff', 'blocker', 'resolution']).default('info'),
    subject: shortText, body: text,
  }), x => { requireActor(x.sender_agent_id); return core.sendMessage(x); });
  tool('message_list', 'Read messages sent or received by an agent.', z.object({
    agent_id: id, task_id: id.optional(), unacknowledged_only: z.boolean().default(false), limit,
  }), x => core.listMessages(x));
  tool('message_acknowledge', 'Acknowledge receipt of a message.', z.object({ message_id: id, agent_id: id }), x => { requireActor(x.agent_id); return core.acknowledgeMessage(x); });

  tool('change_request_create', 'Request a cross-agent change with expected behavior and compatibility impact.', z.object({
    requester_agent_id: id, recipient_agent_id: id, linked_task_id: id.optional(),
    affected_files: strings.min(1), current_behavior: text, expected_behavior: text,
    rationale: text, acceptance_criteria: strings.min(1), compatibility_impact: text,
  }), x => { requireActor(x.requester_agent_id); return core.createChangeRequest(x); });
  tool('change_request_list', 'List change requests involving an agent.', z.object({
    agent_id: id, status: z.enum(['pending', 'accepted', 'rejected', 'completed']).optional(), limit,
  }), x => core.listChangeRequests(x));
  tool('change_request_respond', 'Accept, reject, or complete a request addressed to you.', z.object({
    change_request_id: id, agent_id: id, status: z.enum(['accepted', 'rejected', 'completed']), response_reason: text,
  }), x => { requireActor(x.agent_id); return core.respondChangeRequest(x); });
  tool('audit_list', 'Inspect the persistent mutation audit trail.', z.object({
    entity_type: z.enum(['agent', 'task', 'message', 'change_request', 'file_reservation', 'file_conflict', 'ownership_request']).optional(),
    entity_id: id.optional(), actor_agent_id: id.optional(), limit,
  }), x => core.listAudit(x));

  const filePath = z.string().min(1).max(1024);
  const reservationType = z.enum(['exclusive_write', 'shared_read']);
  const reservationStatus = z.enum(['active', 'released', 'expired', 'revoked']);
  tool('file_ownership_check', 'Check policy ownership and current reservations; this does not acquire a lock.', z.object({
    file_path: filePath, task_id: id.optional(),
  }), x => files.ownershipCheck({ ...x, agent_id: actor() }));
  tool('file_reserve', 'Atomically reserve one file for an active claimed task.', z.object({
    file_path: filePath, task_id: id, reservation_type: reservationType.default('exclusive_write'), reason: shortText.optional(),
  }), x => files.reserve({ ...x, agent_id: actor() }));
  tool('file_reserve_batch', 'Atomically reserve all requested files or none.', z.object({
    task_id: id, file_paths: z.array(filePath).min(1).max(100), reservation_type: reservationType.default('exclusive_write'),
  }), x => files.reserveBatch({ ...x, agent_id: actor() }));
  tool('file_reservation_list', 'List active and historical file reservations.', z.object({
    agent_id: id.optional(), task_id: id.optional(), status: reservationStatus.optional(), file_path: filePath.optional(), limit,
  }), x => { actor(); return files.listReservations(x); });
  tool('file_reservation_renew', 'Renew your active file reservation lease.', z.object({
    reservation_id: id, requested_duration_seconds: z.number().int().min(1).optional(),
  }), x => files.renew({ ...x, agent_id: actor() }));
  tool('file_reservation_release', 'Release your file reservation; repeated release is safe.', z.object({
    reservation_id: id, release_reason: shortText,
  }), x => files.release({ ...x, agent_id: actor() }));
  tool('file_conflict_check', 'Read-only check of intended file changes; a later reservation can still fail.', z.object({
    task_id: id, file_paths: z.array(filePath).min(1).max(100),
  }), x => files.conflictCheck({ ...x, agent_id: actor() }));
  tool('file_conflict_list', 'List open or resolved file conflicts.', z.object({
    agent_id: id.optional(), task_id: id.optional(), status: z.enum(['open', 'resolved']).optional(),
    severity: z.enum(['warning', 'critical']).optional(), limit,
  }), x => { actor(); return files.listConflicts(x); });
  tool('file_ownership_request', 'Request scoped permission to reserve a file owned by another agent.', z.object({
    file_path: filePath, task_id: id, reason: text, expected_changes: text,
  }), x => files.requestOwnership({ ...x, agent_id: actor() }));
  tool('file_ownership_respond', 'Approve or reject an ownership request addressed to you.', z.object({
    ownership_request_id: id, decision: z.enum(['approve', 'reject']), response_message: text.optional(),
  }), x => files.respondOwnership({ ownership_request_id: x.ownership_request_id,
    decision: x.decision === 'approve' ? 'approved' : 'rejected', response_message: x.response_message, agent_id: actor() }));
  tool('file_ownership_request_list', 'List your sent or received ownership requests, including response details.', z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(), limit,
  }), x => files.listOwnershipRequests({ ...x, agent_id: actor() }));
  tool('file_coordination_status', 'Summarize active leases, conflicts, pending approvals, and blocked tasks.', z.object({}), () => {
    actor(); return files.status();
  });

  const workspaces = registerWorkspaceTools(tool, actor);
  server.server.onclose = () => workspaces.close();
  return { server, core };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { server, core } = createServer();
  const transport = new StdioServerTransport();
  process.on('SIGINT', () => { core.close(); process.exit(0); });
  process.on('SIGTERM', () => { core.close(); process.exit(0); });
  server.connect(transport).catch(error => {
    console.error(error);
    core.close();
    process.exitCode = 1;
  });
}
