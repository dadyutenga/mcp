import { MCP_SERVER_NAME } from "./configuration.js";
import { VERSION } from "./version.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { privateFile, agentToken, endpoint } from "./credentials.js";
import { Workspaces, connectAgent } from "./workspaces.js";

const url = endpoint(
  process.env.COORDINATION_URL || "http://127.0.0.1:4310/mcp",
);
const globalMode = Boolean(process.env.COORDINATION_ENROLLMENT_TOKEN_FILE);
if (
  globalMode &&
  (process.env.COORDINATION_AGENT_TOKEN ||
    process.env.COORDINATION_AGENT_TOKEN_FILE ||
    process.env.COORDINATION_REPO_ID)
)
  throw Error(
    "Choose a global enrollment credential or a repository agent credential",
  );
const credential = globalMode
  ? (await privateFile(process.env.COORDINATION_ENROLLMENT_TOKEN_FILE)).trim()
  : await agentToken();
if (!credential || credential.length > 256)
  throw Error("Invalid coordination credential");
const remote = await connectAgent(url, credential, "coordination-stdio-bridge");
if (!globalMode && process.env.COORDINATION_REPO_ID) {
  const result = await remote.callTool({
    name: "agent_setup",
    arguments: { repo_id: process.env.COORDINATION_REPO_ID },
  });
  if (result.isError) throw Error("Agent repository setup is not authorized");
}
const local = new Server(
  { name: MCP_SERVER_NAME, version: VERSION },
  { capabilities: { tools: { listChanged: true } } },
);
let workspaces,
  initialization = Promise.resolve(),
  timer,
  discoveryErrors = [];
const extraTools = [
  {
    name: "workspace_register",
    description:
      "Register the Git repository you are working in. Use an absolute path when your editor does not provide MCP roots. No repository config is written.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_status",
    description:
      "Show registered repositories, their scoped agent identities, and the active repository.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "workspace_select",
    description:
      "Choose the repository for tools in a workspace containing multiple repositories. Get IDs from workspace_status.",
    inputSchema: {
      type: "object",
      properties: { repo_id: { type: "string" } },
      required: ["repo_id"],
      additionalProperties: false,
    },
  },
];
const response = (result) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: { result },
});
if (globalMode) {
  async function discover() {
    const roots = local.getClientCapabilities()?.roots
      ? (await local.listRoots({}, { timeout: 5000 })).roots.map((r) => r.uri)
      : [process.cwd()];
    discoveryErrors = await workspaces.refresh(roots);
  }
  local.oninitialized = () => {
    const clientName =
      process.env.COORDINATION_CLIENT_NAME ||
      local.getClientVersion()?.name ||
      "mcp-agent";
    workspaces = new Workspaces(remote, url, clientName);
    initialization = discover().catch(() => {
      discoveryErrors = [
        { error: "Editor roots unavailable; use workspace_register" },
      ];
    });
    timer = setInterval(() => workspaces.heartbeat(), 60000);
    timer.unref();
  };
  local.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    initialization = initialization
      .then(discover)
      .then(() => local.sendToolListChanged())
      .catch(() => {});
  });
}
local.setRequestHandler(ListToolsRequestSchema, async () => {
  await initialization;
  if (!globalMode) return remote.listTools();
  const first = workspaces?.sessions.values().next().value;
  const tools = first ? (await first.client.listTools()).tools : [];
  return { tools: [...extraTools, ...tools] };
});
local.setRequestHandler(CallToolRequestSchema, async (request) => {
  await initialization;
  if (!globalMode) return remote.callTool(request.params);
  try {
    const args = request.params.arguments || {};
    if (request.params.name === "workspace_status")
      return response({
        ...workspaces.status(),
        discovery_errors: discoveryErrors,
      });
    if (request.params.name === "workspace_select")
      return response(workspaces.select(args.repo_id));
    if (request.params.name === "workspace_register") {
      if (typeof args.path !== "string")
        throw Error("Supply an absolute repository path");
      const result = await workspaces.register(args.path);
      await local.sendToolListChanged();
      return response(result);
    }
    return await workspaces.client(args).callTool(request.params);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
let closing;
function close() {
  if (!closing)
    closing = (async () => {
      clearInterval(timer);
      await initialization;
      await (workspaces ? workspaces.close() : remote.close());
    })();
  return closing;
}
local.onclose = () => {
  close().catch(() => {});
};
await local.connect(new StdioServerTransport());
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    await close();
    await local.close();
    process.exit(0);
  });
