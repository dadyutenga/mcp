import {
  readFile,
  writeFile,
  realpath,
  lstat,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { privateFile, endpoint } from "./credentials.js";
import {
  MCP_SERVER_NAME,
  clientConfiguration,
  singleServerConfiguration,
} from "./configuration.js";
async function safePath(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (info?.isSymbolicLink())
      throw Error("Setup does not follow configuration symlinks");
  }
  return current;
}
export async function installAgent({
  repo,
  url = "http://127.0.0.1:4310/mcp",
  tokenFile,
  repoId,
  client: ideClient = "cursor",
}) {
  const selectedConfig = clientConfiguration(ideClient);
  const root = await realpath(repo),
    credential = await realpath(tokenFile),
    relative = path.relative(root, credential);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw Error("Keep the token file outside the repository");
  const token = (await privateFile(credential)).trim(),
    remote = endpoint(url);
  if (!token || token.length > 256) throw Error("Invalid token file");
  const client = new Client({ name: "coordination-agent-setup", version: "1" });
  let setup;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(remote, {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    const result = await client.callTool({
      name: "agent_setup",
      arguments: repoId ? { repo_id: repoId } : {},
    });
    if (result.isError)
      throw Error(
        result.content?.find((x) => x.type === "text")?.text ||
          "Agent setup rejected",
      );
    setup = z
      .object({ agent_id: z.uuid(), repo_id: z.uuid(), project_id: z.uuid() })
      .passthrough()
      .parse(result.structuredContent?.result);
  } finally {
    await client.close();
  }
  const definition = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./bridge.js", import.meta.url))],
    env: {
      COORDINATION_URL: remote.href,
      COORDINATION_AGENT_TOKEN_FILE: credential,
      COORDINATION_REPO_ID: setup.repo_id,
    },
  };
  const files = [];
  const file = await safePath(root, selectedConfig);
  const text = await readFile(file, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "{}";
    throw e;
  });
  if (Buffer.byteLength(text) > 1048576)
    throw Error("Existing IDE configuration is too large");
  const result = singleServerConfiguration(JSON.parse(text), definition);
  files.push({ file, content: JSON.stringify(result.config, null, 2) + "\n" });
  const ignore = await safePath(root, ".gitignore");
  let ignored = await readFile(ignore, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  for (const rule of ["/" + selectedConfig])
    if (!ignored.split(/\r?\n/).includes(rule))
      ignored += (ignored && !ignored.endsWith("\n") ? "\n" : "") + rule + "\n";
  files.push({ file: ignore, content: ignored });
  for (const { file, content } of files) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  return {
    ...setup,
    server_name: MCP_SERVER_NAME,
    client: ideClient,
    replaced_servers: result.removed,
    configurations: [file],
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        repo: { type: "string" },
        url: { type: "string" },
        "token-file": { type: "string" },
        "repo-id": { type: "string" },
        client: { type: "string", default: "cursor" },
      },
    });
    if (!values.repo || !values["token-file"])
      throw Error(
        "Use --repo /absolute/repo --token-file /absolute/private/agent.token [--repo-id UUID] [--url http://127.0.0.1:4310/mcp] [--client cursor|antigravity]",
      );
    const result = await installAgent({
      repo: values.repo,
      url: values.url,
      tokenFile: values["token-file"],
      repoId: values["repo-id"],
      client: values.client,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
