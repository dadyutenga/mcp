import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = new URL(process.env.COORDINATION_URL || 'http://127.0.0.1:4310/mcp');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol !== 'https:') {
  throw Error('Remote MCP requires HTTPS');
}

const headers = process.env.COORDINATION_AGENT_TOKEN
  ? { Authorization: `Bearer ${process.env.COORDINATION_AGENT_TOKEN}` }
  : {};

const remote = new Client({ name: 'coordination-stdio-bridge', version: '2.0.0' });
await remote.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
const local = new Server({ name: 'coordination-platform', version: '2.0.0' }, { capabilities: { tools: {} } });

local.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
local.setRequestHandler(CallToolRequestSchema, (request) => remote.callTool(request.params));

await local.connect(new StdioServerTransport());

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await remote.close();
    await local.close();
    process.exit(0);
  });
}
