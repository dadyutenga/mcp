import test from "node:test";
import assert from "node:assert/strict";
import {
  clientConfiguration,
  singleServerConfiguration,
} from "../src/configuration.js";
const definition = {
  command: process.execPath,
  args: ["/new/product/src/bridge.js"],
  env: {
    COORDINATION_URL: "http://127.0.0.1:4310/mcp",
    COORDINATION_AGENT_TOKEN_FILE: "/private/current.token",
  },
};
test("dual legacy/central entries become one canonical MCP server and preserve other settings", () => {
  const config = {
    custom: "retained",
    mcpServers: {
      "local-agent-coordination": {
        command: "C:\\Node\\node.exe",
        args: ["C:\\old\\tools\\agent-coordination\\src\\server.js"],
      },
      "coordination-product": {
        command: "node",
        args: ["/old/product/src/bridge.js"],
        env: { COORDINATION_URL: "http://localhost:4310/mcp" },
      },
      anotherAlias: { url: "http://127.0.0.1:4310/mcp" },
      github: { command: "some-other-mcp" },
    },
  };
  const result = singleServerConfiguration(config, definition);
  assert.deepEqual(Object.keys(result.config.mcpServers).sort(), [
    "coordination",
    "github",
  ]);
  assert.equal(result.config.custom, "retained");
  assert.deepEqual(result.config.mcpServers.coordination, definition);
  assert.deepEqual(result.removed, [
    "local-agent-coordination",
    "coordination-product",
    "anotherAlias",
  ]);
  assert.deepEqual(singleServerConfiguration(result.config, definition), {
    config: result.config,
    removed: [],
  });
  assert.ok(config.mcpServers["local-agent-coordination"]);
});
test("one selected client is required and unrecognized coordination entries are not overwritten", () => {
  assert.equal(clientConfiguration(), ".cursor/mcp.json");
  assert.equal(clientConfiguration("antigravity"), ".agents/mcp_config.json");
  assert.throws(() => clientConfiguration("both"), /Choose/);
  assert.throws(() => clientConfiguration("constructor"), /Choose/);
  for (const entry of [
    { command: "unrelated-program" },
    { url: "https://other.example/mcp" },
  ])
    assert.throws(
      () =>
        singleServerConfiguration(
          { mcpServers: { coordination: entry } },
          definition,
        ),
      /review it before replacing/,
    );
  assert.throws(
    () =>
      singleServerConfiguration(
        {
          mcpServers: {
            "local-agent-coordination": { command: "unrelated-program" },
          },
        },
        definition,
      ),
    /unrecognized/,
  );
  const unrelated = {
    command: "node",
    args: ["/other/server.js", "/old/tools/agent-coordination/src/server.js"],
  };
  assert.deepEqual(
    singleServerConfiguration({ mcpServers: { other: unrelated } }, definition)
      .config.mcpServers.other,
    unrelated,
  );
});
