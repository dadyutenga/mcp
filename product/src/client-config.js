import { parse, stringify } from "smol-toml";
import { singleServerConfiguration } from "./configuration.js";

export function renderClientConfiguration(client, text, definition) {
  const toml = client === "codex" || client === "grok";
  let config;
  try {
    config = text.trim()
      ? toml
        ? parse(text, { integersAsBigInt: "asNeeded" })
        : JSON.parse(text)
      : {};
  } catch {
    throw Error(
      `Existing ${toml ? "TOML" : "JSON"} configuration is invalid; repair it before setup (contents withheld)`,
    );
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("Client configuration must be an object");
  const server = {
    ...definition,
    ...(client === "claude" ? { type: "stdio" } : {}),
    ...(toml ? { startup_timeout_sec: 30, tool_timeout_sec: 60 } : {}),
  };
  const result = singleServerConfiguration(
    toml ? { mcpServers: config.mcp_servers } : config,
    server,
  );
  const output = toml
    ? { ...config, mcp_servers: result.config.mcpServers }
    : result.config;
  return {
    content: toml ? stringify(output) : JSON.stringify(output, null, 2) + "\n",
    removed: result.removed,
  };
}
