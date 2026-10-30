import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { agentToken, endpoint } from "./credentials.js";
const url = endpoint(
  process.env.COORDINATION_URL || "http://127.0.0.1:4310/mcp",
);
const credential = await agentToken();
const remote = new Client({
  name: "coordination-stdio-bridge",
  version: "0.1.0",
});
await remote.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${credential}`,
      },
    },
  }),
);
if (process.env.COORDINATION_REPO_ID) {
  const result = await remote.callTool({
    name: "agent_setup",
    arguments: { repo_id: process.env.COORDINATION_REPO_ID },
  });
  if (result.isError) throw Error("Agent repository setup is not authorized");
}
const local = new Server(
  { name: "coordination-platform", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
local.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
local.setRequestHandler(CallToolRequestSchema, (request) =>
  remote.callTool(request.params),
);
await local.connect(new StdioServerTransport());
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    await remote.close();
    await local.close();
    process.exit(0);
  });
