import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { transaction } from "./db.js";

const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_REPO_ID = "00000000-0000-0000-0000-000000000002";

export function nameToUuid(name) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    return name.toLowerCase();
  }
  const h = createHash("sha256").update("agent-coordination:" + (name || randomUUID())).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function ensureDefaultWorkspace(clientOrPool) {
  await clientOrPool.query(
    `INSERT INTO projects(id, body) VALUES($1, $2) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_PROJECT_ID, JSON.stringify({ name: "main-workspace", default_branch: "main" })]
  );
  await clientOrPool.query(
    `INSERT INTO repositories(id, project_id, body) VALUES($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_REPO_ID, DEFAULT_PROJECT_ID, JSON.stringify({ name: "shared-repository", default_branch: "main" })]
  );
}

async function resolveAgent(c, idOrName) {
  await ensureDefaultWorkspace(c);
  const identifier = idOrName || "default-agent";
  const uuid = nameToUuid(identifier);
  const row = (await c.query(`SELECT * FROM agents WHERE id = $1`, [uuid])).rows[0];
  if (row) {
    return { id: uuid, name: row.body?.display_name || row.body?.name || identifier, body: row.body };
  }
  const now = new Date().toISOString();
  const body = {
    id: identifier,
    name: identifier,
    display_name: identifier,
    role: "other",
    capabilities: [],
    metadata: {},
    heartbeat: now,
    registered_at: now,
    revoked: false,
  };
  await c.query(`INSERT INTO agents(id, body) VALUES($1, $2) ON CONFLICT (id) DO NOTHING`, [uuid, JSON.stringify(body)]);
  const grantUuid = nameToUuid(`${uuid}:grant:${DEFAULT_REPO_ID}`);
  await c.query(
    `INSERT INTO agent_repo_grants(id, agent_id, repo_id, project_id, body)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      grantUuid,
      uuid,
      DEFAULT_REPO_ID,
      DEFAULT_PROJECT_ID,
      JSON.stringify({
        permissions: [
          "task:read", "task:claim", "task:update", "task:comment",
          "reservation:acquire", "reservation:release", "context:read",
          "context:publish", "cross_repo:request", "cross_repo:approve"
        ]
      })
    ]
  );
  return { id: uuid, name: identifier, body };
}

export function mcp(service, principal) {
  const pool = service.pool;
  let boundAgent = principal.agent || null;
  let boundAgentId = principal.id || null;

  const server = new McpServer({
    name: "agent-coordination-mcp",
    version: "2.0.0",
  });

  const tool = (name, description, schema, run) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
      },
      async (args) => {
        try {
          const result = await run(schema.parse(args));
          return {
            content: [{ type: "text", text: `${name} succeeded\n${JSON.stringify(result, null, 2)}` }],
            structuredContent: { result },
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: `${name} failed: ${e.message}` }],
          };
        }
      }
    );

  // 1. Agent Self-Registration
  tool(
    "agent_register",
    "Self-register or refresh this agent's identity, role, and capabilities so peers can discover you.",
    z.object({
      id: z.string().trim().min(1).max(128).optional(),
      name: z.string().trim().min(1).max(128).optional(),
      display_name: z.string().trim().min(1).max(128).optional(),
      role: z.enum(["backend", "frontend", "reviewer", "other"]).default("other"),
      capabilities: z.array(z.string()).default([]),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }),
    async (input) => {
      await ensureDefaultWorkspace(pool);
      const identifier = input.id || input.name || input.display_name || boundAgentId || "agent";
      const agentUuid = nameToUuid(identifier);
      const displayName = input.display_name || input.name || input.id || identifier;
      const now = new Date().toISOString();

      return transaction(pool, async (c) => {
        const existing = (await c.query(`SELECT * FROM agents WHERE id = $1`, [agentUuid])).rows[0];
        let agentBody;

        if (existing) {
          agentBody = {
            ...existing.body,
            display_name: displayName,
            role: input.role,
            capabilities: input.capabilities,
            metadata: { ...existing.body?.metadata, ...input.metadata },
            heartbeat: now,
            revoked: false,
          };
          await c.query(
            `UPDATE agents SET body = $1, updated_at = now() WHERE id = $2`,
            [JSON.stringify(agentBody), agentUuid]
          );
        } else {
          agentBody = {
            id: identifier,
            name: identifier,
            display_name: displayName,
            role: input.role,
            capabilities: input.capabilities,
            metadata: input.metadata,
            heartbeat: now,
            registered_at: now,
            revoked: false,
          };
          await c.query(
            `INSERT INTO agents(id, body) VALUES($1, $2)`,
            [agentUuid, JSON.stringify(agentBody)]
          );
        }

        const grantUuid = nameToUuid(`${agentUuid}:grant:${DEFAULT_REPO_ID}`);
        await c.query(
          `INSERT INTO agent_repo_grants(id, agent_id, repo_id, project_id, body)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET body = excluded.body`,
          [
            grantUuid,
            agentUuid,
            DEFAULT_REPO_ID,
            DEFAULT_PROJECT_ID,
            JSON.stringify({
              permissions: [
                "task:read", "task:claim", "task:update", "task:comment",
                "reservation:acquire", "reservation:release", "context:read",
                "context:publish", "cross_repo:request", "cross_repo:approve"
              ]
            })
          ]
        );

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [
            displayName,
            existing ? "agent_reregistered" : "agent_registered",
            agentUuid,
            DEFAULT_REPO_ID,
            JSON.stringify({ role: input.role, capabilities: input.capabilities })
          ]
        );

        boundAgentId = agentUuid;
        boundAgent = { id: agentUuid, ...agentBody };
        principal.id = agentUuid;
        principal.agent = boundAgent;

        return {
          status: "registered",
          agent_id: agentUuid,
          identifier,
          display_name: displayName,
          role: input.role,
          capabilities: input.capabilities,
          registered_at: agentBody.registered_at || now,
          last_seen_at: now,
          workspace: {
            project_id: DEFAULT_PROJECT_ID,
            repository_id: DEFAULT_REPO_ID,
          }
        };
      });
    }
  );

  // 2. Discover Peers / Agent List
  tool(
    "agent_list",
    "Discover other registered agents, their current status, roles, and capabilities to see who else is working.",
    z.object({
      role: z.enum(["backend", "frontend", "reviewer", "other"]).optional(),
    }),
    async (input) => {
      const { rows } = await pool.query(
        `SELECT id, body, created_at, updated_at FROM agents
         WHERE NOT (body->>'revoked')::boolean OR body->>'revoked' IS NULL
         ORDER BY created_at ASC`
      );

      const now = Date.now();
      const agents = rows.map((r) => {
        const b = r.body || {};
        const lastSeen = b.heartbeat ? new Date(b.heartbeat).getTime() : new Date(r.updated_at).getTime();
        const isActive = now - lastSeen < 15 * 60 * 1000;
        return {
          id: r.id,
          identifier: b.id || b.name || r.id,
          display_name: b.display_name || b.name || r.id,
          role: b.role || "other",
          capabilities: b.capabilities || [],
          status: isActive ? "active" : "idle",
          last_seen_at: b.heartbeat || r.updated_at,
          registered_at: b.registered_at || r.created_at,
          metadata: b.metadata || {},
        };
      });

      if (input.role) {
        return agents.filter((a) => a.role === input.role);
      }
      return agents;
    }
  );

  // 3. Heartbeat
  tool(
    "agent_heartbeat",
    "Ping the coordination server to update your last seen timestamp so peers know you are active.",
    z.object({
      agent_id: z.string().optional(),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const now = new Date().toISOString();
        await c.query(
          `UPDATE agents SET body = jsonb_set(body, '{heartbeat}', to_jsonb($1::text)), updated_at = now() WHERE id = $2`,
          [now, agent.id]
        );
        return { success: true, agent_id: agent.id, heartbeat: now };
      });
    }
  );

  // 4. Complete State Snapshot
  tool(
    "state_snapshot",
    "See what all agents are doing: returns all registered agents, active tasks, file reservations, and recent activity.",
    z.object({
      agent_id: z.string().optional(),
    }),
    async (input) => {
      const now = Date.now();
      const currentAgentId = input.agent_id ? nameToUuid(input.agent_id) : boundAgentId;

      const [agentRows, taskRows, resRows, auditRows, msgRows] = await Promise.all([
        pool.query(`SELECT id, body, created_at, updated_at FROM agents WHERE NOT (body->>'revoked')::boolean OR body->>'revoked' IS NULL ORDER BY created_at ASC`),
        pool.query(`SELECT id, project_id, repo_id, body, created_at, updated_at FROM tasks WHERE body->>'state' != 'cancelled' ORDER BY CASE body->>'state' WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, created_at DESC LIMIT 50`),
        pool.query(`SELECT id, repo_id, body, created_at FROM file_reservations WHERE body->>'state' = 'active' AND (body->>'expires_at')::timestamptz > now() ORDER BY created_at DESC`),
        pool.query(`SELECT id, actor, action, resource_id, metadata, timestamp FROM audit_events ORDER BY id DESC LIMIT 20`),
        pool.query(`SELECT id, body, created_at FROM messages ORDER BY created_at DESC LIMIT 20`),
      ]);

      const agents = agentRows.rows.map((r) => {
        const b = r.body || {};
        const lastSeen = b.heartbeat ? new Date(b.heartbeat).getTime() : new Date(r.updated_at).getTime();
        return {
          id: r.id,
          identifier: b.id || b.name || r.id,
          display_name: b.display_name || b.name || r.id,
          role: b.role || "other",
          capabilities: b.capabilities || [],
          status: now - lastSeen < 15 * 60 * 1000 ? "active" : "idle",
          last_seen_at: b.heartbeat || r.updated_at,
        };
      });

      const callerObj = agents.find((a) => a.id === currentAgentId) || boundAgent || { status: "unregistered" };

      const tasks = taskRows.rows.map((r) => ({
        id: r.id,
        title: r.body?.title,
        description: r.body?.description,
        state: r.body?.state || "ready",
        priority: r.body?.priority || 3,
        progress: r.body?.progress || 0,
        assignee_id: r.body?.assignee,
        creator: r.body?.creator,
        blockers: r.body?.blockers || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      const activeReservations = resRows.rows.map((r) => ({
        id: r.id,
        path: r.body?.path,
        holder_id: r.body?.holder_id,
        holder_name: r.body?.holder_name,
        task_id: r.body?.task_id,
        expires_at: r.body?.expires_at,
      }));

      const recentActivity = auditRows.rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        resource_id: r.resource_id,
        metadata: r.metadata,
        timestamp: r.timestamp,
      }));

      return {
        caller: callerObj,
        agents,
        tasks,
        active_file_reservations: activeReservations,
        recent_activity: recentActivity,
        messages_count: msgRows.rows.length,
      };
    }
  );

  // 5. Create Task
  tool(
    "task_create",
    "Create a task in the shared workspace with title, description, priority, and optional assignee.",
    z.object({
      title: z.string().trim().min(1).max(500),
      description: z.string().default(""),
      priority: z.number().int().min(1).max(5).default(3),
      assignee_id: z.string().optional(),
      agent_id: z.string().optional(),
      acceptance_criteria: z.array(z.string()).default([]),
    }),
    async (input) => {
      const taskId = randomUUID();
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const assignee = input.assignee_id ? await resolveAgent(c, input.assignee_id) : null;

        const taskBody = {
          title: input.title,
          description: input.description,
          priority: input.priority,
          state: "ready",
          progress: 0,
          creator: agent.name,
          assignee: assignee ? assignee.id : null,
          acceptance_criteria: input.acceptance_criteria,
          blockers: [],
        };

        await c.query(
          `INSERT INTO tasks(id, project_id, repo_id, agent_id, body)
           VALUES($1, $2, $3, $4, $5)`,
          [taskId, DEFAULT_PROJECT_ID, DEFAULT_REPO_ID, agent.id, JSON.stringify(taskBody)]
        );

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [agent.name, "task_created", taskId, DEFAULT_REPO_ID, JSON.stringify({ title: input.title, priority: input.priority })]
        );

        return { id: taskId, ...taskBody };
      });
    }
  );

  // 6. List Tasks
  tool(
    "task_list",
    "List tasks across the shared workspace to see what is ready, in progress, blocked, or completed.",
    z.object({
      state: z.enum(["ready", "in_progress", "blocked", "done", "cancelled", "backlog"]).optional(),
      assignee_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async (input) => {
      const params = [];
      const filters = [];
      if (input.state) {
        params.push(input.state);
        filters.push(`body->>'state' = $${params.length}`);
      }
      if (input.assignee_id) {
        params.push(nameToUuid(input.assignee_id));
        filters.push(`body->>'assignee' = $${params.length}`);
      }
      params.push(input.limit);

      const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const { rows } = await pool.query(
        `SELECT id, project_id, repo_id, body, created_at, updated_at FROM tasks
         ${whereClause}
         ORDER BY CASE body->>'state' WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return rows.map((r) => ({
        id: r.id,
        title: r.body?.title,
        description: r.body?.description,
        state: r.body?.state || "ready",
        priority: r.body?.priority || 3,
        progress: r.body?.progress || 0,
        assignee_id: r.body?.assignee,
        creator: r.body?.creator,
        acceptance_criteria: r.body?.acceptance_criteria || [],
        blockers: r.body?.blockers || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
    }
  );

  // 7. Claim Task
  tool(
    "task_claim",
    "Atomically claim an open task so peers know you are currently working on it.",
    z.object({
      task_id: z.string().trim().min(1),
      agent_id: z.string().optional(),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const { rows } = await c.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [input.task_id]);
        if (!rows.length) throw new Error(`Task not found: ${input.task_id}`);
        const task = rows[0];
        const body = task.body || {};

        if (body.state === "in_progress" && body.assignee && body.assignee !== agent.id) {
          throw new Error(`Task already claimed by another agent (${body.assignee})`);
        }

        const updatedBody = {
          ...body,
          state: "in_progress",
          assignee: agent.id,
          claimed_by_name: agent.name,
          claimed_at: new Date().toISOString(),
        };

        await c.query(
          `UPDATE tasks SET body = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(updatedBody), input.task_id]
        );

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [agent.name, "task_claimed", input.task_id, task.repo_id, JSON.stringify({ previous_state: body.state })]
        );

        return { id: input.task_id, ...updatedBody };
      });
    }
  );

  // 8. Update Task Progress / Blockers
  tool(
    "task_update",
    "Update progress (0-100), state (in_progress, blocked, ready), or note blockers on your task.",
    z.object({
      task_id: z.string().trim().min(1),
      agent_id: z.string().optional(),
      state: z.enum(["ready", "in_progress", "blocked", "done", "cancelled"]).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      comment: z.string().optional(),
      blockers: z.array(z.string()).optional(),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const { rows } = await c.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [input.task_id]);
        if (!rows.length) throw new Error(`Task not found: ${input.task_id}`);
        const body = rows[0].body || {};

        const updatedBody = {
          ...body,
          state: input.state || body.state,
          progress: input.progress !== undefined ? input.progress : body.progress,
          blockers: input.blockers || body.blockers || [],
        };

        if (input.comment) {
          updatedBody.comments = [
            ...(body.comments || []),
            { author: agent.name, text: input.comment, timestamp: new Date().toISOString() }
          ];
        }

        await c.query(
          `UPDATE tasks SET body = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(updatedBody), input.task_id]
        );

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [agent.name, "task_updated", input.task_id, rows[0].repo_id, JSON.stringify({ state: updatedBody.state, progress: updatedBody.progress })]
        );

        return { id: input.task_id, ...updatedBody };
      });
    }
  );

  // 9. Complete Task
  tool(
    "task_complete",
    "Mark a task completed with verification evidence, releasing any linked file reservations.",
    z.object({
      task_id: z.string().trim().min(1),
      agent_id: z.string().optional(),
      completion_details: z.string().min(1),
      verification_evidence: z.string().default("Verified"),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const { rows } = await c.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [input.task_id]);
        if (!rows.length) throw new Error(`Task not found: ${input.task_id}`);
        const body = rows[0].body || {};

        const updatedBody = {
          ...body,
          state: "done",
          progress: 100,
          completed_at: new Date().toISOString(),
          completion_details: input.completion_details,
          verification_evidence: input.verification_evidence,
        };

        await c.query(
          `UPDATE tasks SET body = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(updatedBody), input.task_id]
        );

        await c.query(
          `UPDATE file_reservations SET body = jsonb_set(body, '{state}', '"released"'), updated_at = now()
           WHERE body->>'task_id' = $1 AND body->>'state' = 'active'`,
          [input.task_id]
        );

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [agent.name, "task_completed", input.task_id, rows[0].repo_id, JSON.stringify({ details: input.completion_details })]
        );

        return { id: input.task_id, ...updatedBody };
      });
    }
  );

  // 10. File Reserve (Exclusive Write Leases)
  tool(
    "file_reserve",
    "Acquire time-limited exclusive reservation on file paths before editing, preventing collision with other agents.",
    z.object({
      paths: z.array(z.string().min(1)).min(1),
      agent_id: z.string().optional(),
      task_id: z.string().optional(),
      ttl_seconds: z.number().int().min(30).max(3600).default(900),
    }),
    async (input) => {
      const expiresAt = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();

      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const normalizedPaths = input.paths.map((p) => p.replace(/\\/g, "/").toLowerCase());

        const { rows: conflicts } = await c.query(
          `SELECT id, body FROM file_reservations
           WHERE body->>'state' = 'active'
           AND (body->>'expires_at')::timestamptz > now()
           AND body->>'holder_id' != $1
           AND body->>'normalized' = ANY($2)`,
          [agent.id, normalizedPaths]
        );

        if (conflicts.length > 0) {
          const first = conflicts[0].body;
          return {
            acquired: false,
            reason: "CONFLICT",
            conflicting_path: first.path,
            held_by: first.holder_name || first.holder_id,
            expires_at: first.expires_at,
          };
        }

        const reserved = [];
        for (const filePath of input.paths) {
          const norm = filePath.replace(/\\/g, "/").toLowerCase();
          const resId = randomUUID();
          const resBody = {
            path: filePath,
            normalized: norm,
            state: "active",
            holder_id: agent.id,
            holder_name: agent.name,
            task_id: input.task_id || null,
            expires_at: expiresAt,
          };

          await c.query(
            `INSERT INTO file_reservations(id, project_id, repo_id, agent_id, body)
             VALUES($1, $2, $3, $4, $5)`,
            [resId, DEFAULT_PROJECT_ID, DEFAULT_REPO_ID, agent.id, JSON.stringify(resBody)]
          );
          reserved.push({ id: resId, path: filePath, expires_at: expiresAt });
        }

        await c.query(
          `INSERT INTO audit_events(actor, action, resource_id, repo_id, metadata)
           VALUES($1, $2, $3, $4, $5)`,
          [agent.name, "files_reserved", input.task_id || null, DEFAULT_REPO_ID, JSON.stringify({ paths: input.paths, expires_at: expiresAt })]
        );

        return { acquired: true, reserved_files: reserved, expires_at: expiresAt };
      });
    }
  );

  // 11. List File Reservations
  tool(
    "file_reservation_list",
    "View all currently active file reservations to see what files other agents are modifying.",
    z.object({
      active_only: z.boolean().default(true),
    }),
    async () => {
      const { rows } = await pool.query(
        `SELECT id, body, created_at FROM file_reservations
         WHERE body->>'state' = 'active' AND (body->>'expires_at')::timestamptz > now()
         ORDER BY created_at DESC`
      );

      return rows.map((r) => ({
        id: r.id,
        path: r.body?.path,
        holder_name: r.body?.holder_name,
        holder_id: r.body?.holder_id,
        task_id: r.body?.task_id,
        expires_at: r.body?.expires_at,
      }));
    }
  );

  // 12. Release File Reservations
  tool(
    "file_reservation_release",
    "Release reservations on files after finishing edits so peers can work on them.",
    z.object({
      paths: z.array(z.string()).optional(),
      reservation_id: z.string().optional(),
      agent_id: z.string().optional(),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);

        if (input.reservation_id) {
          await c.query(
            `UPDATE file_reservations SET body = jsonb_set(body, '{state}', '"released"'), updated_at = now()
             WHERE id = $1 AND body->>'holder_id' = $2`,
            [input.reservation_id, agent.id]
          );
        } else if (input.paths?.length) {
          const normalized = input.paths.map((p) => p.replace(/\\/g, "/").toLowerCase());
          await c.query(
            `UPDATE file_reservations SET body = jsonb_set(body, '{state}', '"released"'), updated_at = now()
             WHERE body->>'normalized' = ANY($1) AND body->>'holder_id' = $2`,
            [normalized, agent.id]
          );
        }
        return { released: true };
      });
    }
  );

  // 13. File Coordination Status
  tool(
    "file_coordination_status",
    "Overview of all active file locks, potential conflicts, and files currently being edited.",
    z.object({}),
    async () => {
      const { rows } = await pool.query(
        `SELECT id, body FROM file_reservations
         WHERE body->>'state' = 'active' AND (body->>'expires_at')::timestamptz > now()`
      );
      return {
        active_locks_count: rows.length,
        locked_files: rows.map((r) => ({
          path: r.body?.path,
          locked_by: r.body?.holder_name || r.body?.holder_id,
          expires_at: r.body?.expires_at,
        })),
      };
    }
  );

  // 14. Message Send (Inter-Agent Communication)
  tool(
    "message_send",
    "Send a persistent message or notification to another agent or broadcast to all agents.",
    z.object({
      recipient: z.string().default("all"),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
      agent_id: z.string().optional(),
      message_type: z.enum(["info", "question", "handoff", "blocker"]).default("info"),
    }),
    async (input) => {
      return transaction(pool, async (c) => {
        const agent = await resolveAgent(c, input.agent_id || boundAgentId);
        const msgId = randomUUID();

        const msgBody = {
          sender_id: agent.id,
          sender_name: agent.name,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
          message_type: input.message_type,
          timestamp: new Date().toISOString(),
        };

        await c.query(
          `INSERT INTO messages(id, project_id, repo_id, agent_id, body)
           VALUES($1, $2, $3, $4, $5)`,
          [msgId, DEFAULT_PROJECT_ID, DEFAULT_REPO_ID, agent.id, JSON.stringify(msgBody)]
        );

        return { sent: true, message_id: msgId, ...msgBody };
      });
    }
  );

  // 15. Message List
  tool(
    "message_list",
    "Read persistent messages sent to you or broadcasted to the workspace.",
    z.object({
      agent_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async (input) => {
      const agentUuid = input.agent_id ? nameToUuid(input.agent_id) : boundAgentId;
      const { rows } = await pool.query(
        `SELECT id, body, created_at FROM messages
         WHERE body->>'recipient' = 'all'
            OR body->>'recipient' = $1
            OR body->>'sender_id' = $1
         ORDER BY created_at DESC LIMIT $2`,
        [agentUuid || "", input.limit]
      );

      return rows.map((r) => ({
        id: r.id,
        sender: r.body?.sender_name,
        sender_id: r.body?.sender_id,
        recipient: r.body?.recipient,
        subject: r.body?.subject,
        body: r.body?.body,
        message_type: r.body?.message_type,
        timestamp: r.body?.timestamp || r.created_at,
      }));
    }
  );

  // 16. Audit Log of Agent Actions
  tool(
    "audit_list",
    "Inspect the chronological audit log to see what other agents have recently done in the project.",
    z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async (input) => {
      const { rows } = await pool.query(
        `SELECT id, actor, action, resource_id, metadata, timestamp
         FROM audit_events
         ORDER BY id DESC LIMIT $1`,
        [input.limit]
      );
      return rows;
    }
  );

  return server;
}
