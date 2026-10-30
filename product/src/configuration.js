export const MCP_SERVER_NAME = "coordination";
export const CLIENT_CONFIGS = Object.freeze({
  cursor: ".cursor/mcp.json",
  antigravity: ".agents/mcp_config.json",
});
export function clientConfiguration(client = "cursor") {
  if (!Object.hasOwn(CLIENT_CONFIGS, client))
    throw Error("Choose --client cursor or --client antigravity");
  return CLIENT_CONFIGS[client];
}
const oldNames = new Set(["local-agent-coordination", "coordination-product"]);
const normalizePath = (value) => value.replaceAll("\\", "/");
function sameEndpoint(value, target) {
  try {
    const normalize = (input) => {
      const u = new URL(input);
      if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
        u.hostname = "localhost";
      return u.href;
    };
    return normalize(value) === normalize(target);
  } catch {
    return false;
  }
}
function owned(entry, definition) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const target = definition.env.COORDINATION_URL;
  if (typeof entry.url === "string") return sameEndpoint(entry.url, target);
  if (
    typeof entry.command !== "string" ||
    !/(?:^|\/)node(?:\.exe)?$/i.test(normalizePath(entry.command)) ||
    !Array.isArray(entry.args)
  )
    return false;
  const scripts = entry.args
    .slice(0, 1)
    .filter((arg) => typeof arg === "string")
    .map(normalizePath);
  if (
    scripts.some((script) =>
      /(?:^|\/)tools\/agent-coordination\/src\/server\.js$/i.test(script),
    )
  )
    return true;
  if (
    scripts.some(
      (script) =>
        script === normalizePath(definition.args[0]) ||
        /(?:^|\/)product\/src\/bridge\.js$/i.test(script),
    )
  )
    return sameEndpoint(
      entry.env?.COORDINATION_URL || "http://127.0.0.1:4310/mcp",
      target,
    );
  return false;
}
export function singleServerConfiguration(config, definition) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    (config.mcpServers &&
      (typeof config.mcpServers !== "object" ||
        Array.isArray(config.mcpServers)))
  )
    throw Error("IDE configuration must contain an mcpServers object");
  const servers = {},
    removed = [];
  for (const [name, entry] of Object.entries(config.mcpServers || {})) {
    if (owned(entry, definition)) {
      if (name !== MCP_SERVER_NAME) removed.push(name);
      continue;
    }
    if (name === MCP_SERVER_NAME || oldNames.has(name))
      throw Error(
        "Existing " +
          name +
          " entry points to an unrecognized or different service; review it before replacing",
      );
    Object.defineProperty(servers, name, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  servers[MCP_SERVER_NAME] = definition;
  return { config: { ...config, mcpServers: servers }, removed };
}
