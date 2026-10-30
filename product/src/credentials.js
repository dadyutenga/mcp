import { readFile, lstat, realpath } from "node:fs/promises";
export async function privateFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Select a regular private credential file");
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
  )
    throw Error("Credential files must be owned by you with mode 600");
  if (stat.size > 65536) throw Error("Credential file too large");
  return readFile(await realpath(file), "utf8");
}
export async function agentToken() {
  if (
    process.env.COORDINATION_AGENT_TOKEN &&
    process.env.COORDINATION_AGENT_TOKEN_FILE
  )
    throw Error("Configure one agent token source");
  const raw =
    process.env.COORDINATION_AGENT_TOKEN ||
    (process.env.COORDINATION_AGENT_TOKEN_FILE
      ? await privateFile(process.env.COORDINATION_AGENT_TOKEN_FILE)
      : "");
  if (!raw.trim() || raw.trim().length > 256)
    throw Error(
      "COORDINATION_AGENT_TOKEN or COORDINATION_AGENT_TOKEN_FILE required",
    );
  return raw.trim();
}
export function endpoint(input) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Use an HTTP(S) URL without embedded credentials");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.protocol !== "https:"
  )
    throw Error("Remote MCP requires HTTPS");
  return url;
}
