import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
export function mcp(service, principal) {
  const server = new McpServer({
    name: "coordination-platform",
    version: "0.1.0",
  });
  const tool = (name, schema, run) =>
    server.registerTool(
      name,
      {
        description: `Authenticated ${name}; identity comes from your token, not tool arguments.`,
        inputSchema: schema,
      },
      async (args) => {
        try {
          const result = await run(args);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { result },
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      },
    );
  tool("identity_get", z.object({}), () => service.identity(principal));
  tool(
    "events_poll",
    z.object({ after: z.number().int().nonnegative().default(0) }),
    (x) => service.events(principal, x.after),
  );
  for (const name of [
    "tasks",
    "repositories",
    "projects",
    "task_events",
    "file_reservations",
    "cross_repo_requests",
    "cross_repo_responses",
    "shared_context_items",
  ])
    tool(
      name + "_list",
      z.object({
        after: z.string().optional(),
        repo_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        full: z.boolean().default(false),
      }),
      (x) => service.read(principal, name, x),
    );
  for (const name of [
    "tasks",
    "cross_repo_requests",
    "cross_repo_responses",
    "shared_context_items",
    "file_reservations",
  ])
    tool(name + "_get", z.object({ id: z.uuid() }), (x) =>
      service.resource(principal, name, x.id),
    );
  for (const name of [
    "task_claim",
    "task_update",
    "task_comment",
    "task_handoff",
    "reservation_acquire",
    "reservation_release",
    "request_create",
    "request_clarify",
    "request_decide",
    "request_answer",
    "context_publish",
  ])
    tool(
      name,
      z.object({
        input: z.record(z.string(), z.unknown()),
        idempotency_key: z.string().max(128).optional(),
      }),
      (x) => service.execute(principal, name, x.input, x.idempotency_key),
    );
  return server;
}
