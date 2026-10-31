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
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { endpoint, privateFile } from "./credentials.js";
import {
  globalClientConfiguration,
  GLOBAL_CLIENTS,
  normalizeGlobalClient,
} from "./configuration.js";
import { renderClientConfiguration } from "./client-config.js";
import { connectAgent, gitWorkspace } from "./workspaces.js";

async function configurationPath(home, relative) {
  let current = home;
  for (const part of relative.split(/[\\/]/)) {
    if (!part || part === "." || part === "..")
      throw Error("Use a configuration path within your home directory");
    current = path.join(current, part);
    const stat = await lstat(current).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat?.isSymbolicLink())
      throw Error("Setup does not follow configuration symlinks");
  }
  return current;
}

export async function installGlobal({
  client = "cursor",
  tokenFile,
  url = "http://127.0.0.1:4310/mcp",
  home = os.homedir(),
  configFile,
  projectId,
}) {
  client = normalizeGlobalClient(client);
  if (!GLOBAL_CLIENTS.includes(client))
    throw Error("Unknown global MCP client");
  if (client === "generic" && !configFile)
    throw Error(
      "Generic JSON setup requires --config-file within your home directory",
    );
  const root = await realpath(home);
  const relative = configFile
    ? path.relative(root, path.resolve(configFile))
    : globalClientConfiguration(client);
  // Validate the selected client even when a custom config path is supplied.
  if (client !== "generic") globalClientConfiguration(client);
  const file = await configurationPath(root, relative);
  const credential = await realpath(tokenFile);
  let inRepo = false;
  try {
    await gitWorkspace(path.dirname(credential));
    inRepo = true;
  } catch {
    /* Private directory outside Git. */
  }
  if (inRepo)
    throw Error("Keep enrollment credentials outside Git repositories");
  if (file === credential)
    throw Error("Credential and IDE configuration must be separate files");
  const remoteUrl = endpoint(url);
  const raw = (await privateFile(tokenFile)).trim();
  if (!raw || raw.length > 256) throw Error("Invalid enrollment credential");
  const remote = await connectAgent(
    remoteUrl,
    raw,
    "coordination-global-setup",
  );
  try {
    const names = (await remote.listTools()).tools.map((t) => t.name);
    if (
      !names.includes("installation_info") ||
      !names.includes("workspace_register")
    )
      throw Error("Use a project enrollment credential for global setup");
    const result = await remote.callTool({
      name: "installation_info",
      arguments: {},
    });
    if (result.isError) throw Error("Installation is unavailable");
    if (projectId && result.structuredContent.result.project_id !== projectId)
      throw Error(
        "Existing enrollment credential belongs to another project; use a separate token file",
      );
  } finally {
    await remote.close();
  }
  const definition = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./bridge.js", import.meta.url))],
    env: {
      COORDINATION_URL: remoteUrl.href,
      COORDINATION_ENROLLMENT_TOKEN_FILE: credential,
      COORDINATION_CLIENT_NAME: client,
    },
  };
  const text = await readFile(file, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  if (Buffer.byteLength(text) > 1048576)
    throw Error("Existing IDE configuration is too large");
  const result = renderClientConfiguration(client, text, definition);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (text && text !== result.content) {
    await writeFile(file + ".coordination-backup", text, {
      mode: 0o600,
      flag: "wx",
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, result.content, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    server_name: "coordination",
    client,
    configurations: [file],
    replaced_servers: result.removed,
    automatic_registration: true,
  };
}

const schema = z
  .object({
    url: z.string().default("http://127.0.0.1:4310/mcp"),
    username: z.string().min(3),
    password: z.string().min(12),
    bootstrap_secret: z.string().optional(),
    project: z.string().min(1),
    client: z.preprocess(
      (value) => normalizeGlobalClient(value ?? "cursor"),
      z.enum(GLOBAL_CLIENTS),
    ),
    token_file: z.string(),
    config_file: z.string().optional(),
    expires_hours: z.number().min(1).max(8760).default(720),
  })
  .strict();

export async function provisionGlobal(input, { home } = {}) {
  const config = schema.parse(input);
  const base = new URL("/api/v1/", endpoint(config.url));
  let cookie = "",
    csrf = "";
  async function api(route, body) {
    const response = await fetch(new URL(route, base), {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(value.error?.message || "Global setup rejected");
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return value;
  }
  if ((await api("auth/setup")).bootstrap_required) {
    if (!config.bootstrap_secret)
      throw Error(
        "First setup needs the service bootstrap secret; run node setup.mjs for guided setup",
      );
    await api("auth/bootstrap", {
      secret: config.bootstrap_secret,
      username: config.username,
      password: config.password,
    });
  }
  csrf = (
    await api("auth/session", {
      username: config.username,
      password: config.password,
    })
  ).csrf;
  try {
    let after = "",
      matches = [];
    do {
      const page = await api("resources/projects?after=" + after);
      matches.push(...page.items.filter((p) => p.name === config.project));
      if (!page.has_more) break;
      after = page.next_cursor;
    } while (true);
    if (matches.length > 1) throw Error("Use a unique project name");
    const project =
      matches[0] ||
      (await api("actions/project_create", { name: config.project }));
    if (project.status !== "active") throw Error("Project is archived");
    const exists = await lstat(config.token_file).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!exists) {
      // Resolve the directory before issuance; credentials must never land in a repo.
      await mkdir(path.dirname(path.resolve(config.token_file)), {
        recursive: true,
        mode: 0o700,
      });
      let inRepo = false;
      try {
        await gitWorkspace(
          await realpath(path.dirname(path.resolve(config.token_file))),
        );
        inRepo = true;
      } catch {}
      if (inRepo)
        throw Error("Keep enrollment credentials outside Git repositories");
      const enrollment = await api("actions/installation_create", {
        project_id: project.id,
        name: config.client,
        expires_hours: config.expires_hours,
      });
      try {
        await writeFile(config.token_file, enrollment.token + "\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        await api("actions/agent_revoke", { id: enrollment.agent.id }).catch(
          () => {},
        );
        throw error;
      }
    }
    return await installGlobal({
      client: config.client,
      tokenFile: config.token_file,
      url: config.url,
      home,
      configFile: config.config_file,
      projectId: project.id,
    });
  } finally {
    await fetch(new URL("auth/session", base), {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    }).catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        client: { type: "string", default: "cursor" },
        "token-file": { type: "string" },
        url: { type: "string" },
        "config-file": { type: "string" },
      },
    });
    const result = values.config
      ? await provisionGlobal(JSON.parse(await privateFile(values.config)))
      : await installGlobal({
          client: values.client,
          tokenFile: values["token-file"],
          url: values.url,
          configFile: values["config-file"],
        });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
