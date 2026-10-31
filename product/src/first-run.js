import { writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createInterface, emitKeypressEvents } from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { endpoint, privateFile } from "./credentials.js";
import { gitWorkspace } from "./workspaces.js";
import { provisionGlobal } from "./global-setup.js";
import { selectedClients } from "./configuration.js";
import {
  prepareLocal,
  readEnvironment,
  serviceReady,
} from "./local-service.js";
export { prepareLocal } from "./local-service.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const randomSecret = () => randomBytes(32).toString("hex");
const key = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export async function question(label, fallback = "", { secret = false } = {}) {
  if (!process.stdin.isTTY)
    throw Error(
      "Guided setup needs an interactive terminal. Use --config with a private setup file for automation.",
    );
  const suffix = fallback ? ` [${fallback}]` : "";
  if (!secret) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await new Promise((resolve) =>
        rl.question(`${label}${suffix}: `, (answer) =>
          resolve(answer.trim() || fallback),
        ),
      );
    } finally {
      rl.close();
    }
  }
  process.stdout.write(`${label}: `);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function finish(error) {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    function onKey(text, event = {}) {
      if (event.ctrl && event.name === "c")
        return finish(Error("Setup cancelled. Run it again when ready."));
      if (event.name === "return" || event.name === "enter") return finish();
      if (event.name === "backspace") value = value.slice(0, -1);
      else if (
        text &&
        !event.ctrl &&
        !event.meta &&
        !/[\x00-\x1f\x7f]/.test(text)
      )
        value += text;
    }
    process.stdin.on("keypress", onKey);
  });
}

async function reachable(url) {
  try {
    const response = await fetch(new URL("/api/v1/auth/setup", url), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return typeof value.bootstrap_required === "boolean" ? value : null;
  } catch {
    return null;
  }
}

export async function firstRun({
  root = projectRoot,
  home = os.homedir(),
  url: inputUrl,
  client,
  project,
  prompt = question,
  log = console.log,
  startLocalService,
} = {}) {
  const url = endpoint(
    inputUrl || (await prompt("Service URL", "http://127.0.0.1:4310/mcp")),
  );
  if (url.pathname !== "/mcp")
    throw Error("Use the service URL ending in /mcp");
  const selected = selectedClients(
    client ||
      (await prompt(
        "Clients: cursor, antigravity, codex, claude, grok (comma-separated), or all",
        "cursor",
      )),
  );
  const directory = path.join(
    home,
    ".config",
    "agent-coordination",
    "installations",
    key(url.href),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let insideGit = false;
  try {
    await gitWorkspace(await realpath(directory));
    insideGit = true;
  } catch {}
  if (insideGit)
    throw Error(
      "Your private setup directory must be outside Git repositories",
    );
  const profileFile = path.join(directory, "owner.json");
  const info = await lstat(profileFile).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  let profile = info ? JSON.parse(await privateFile(profileFile)) : null;
  if (profile && profile.url !== url.href)
    throw Error("Saved setup belongs to a different service");
  const projectName = (
    project ||
    (await prompt("Workspace/project name", profile?.project || "my-workspace"))
  ).trim();
  if (!projectName || projectName.length > 500)
    throw Error("Use a project name between 1 and 500 characters");
  log(`Checking coordination service at ${url.href}...`);
  let state = await reachable(url),
    bootstrap;
  if (state && !(await serviceReady(url)))
    throw Error(
      "The service at this URL is not healthy. Check PostgreSQL and verify the coordination service URL before continuing.",
    );
  if (!state) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error(
        "Service unavailable. Check the HTTPS URL and start the remote service first.",
      );
    const local = await prepareLocal({
      root,
      url,
      directory,
      prompt,
      log,
      ...(startLocalService ? { start: startLocalService } : {}),
    });
    bootstrap = local.bootstrap;
    state = await reachable(url);
    if (!state)
      throw Error(
        "Service is not ready after startup. Check the private service log and saved PostgreSQL settings.",
      );
  }
  if (state.bootstrap_required) {
    if (
      !bootstrap &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      bootstrap = (await readEnvironment(path.join(root, "product", ".env")))
        .values.BOOTSTRAP_SECRET;
    if (!bootstrap)
      bootstrap = await prompt("Service bootstrap secret", "", {
        secret: true,
      });
    if (!profile) profile = { username: "operator", password: randomSecret() };
  } else if (!profile) {
    profile = {
      username: await prompt(
        "Coordination owner username (separate from PostgreSQL)",
        "operator",
      ),
      password: await prompt("Coordination owner password", "", {
        secret: true,
      }),
    };
  }
  // Save generated account details before bootstrap so interrupted runs can recover.
  // Existing account credentials are saved only after a successful login below.
  const saved = { ...profile, url: url.href, project: projectName };
  if (state.bootstrap_required && !info)
    await writeFile(profileFile, JSON.stringify(saved, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const results = [];
  for (const editor of selected) {
    log(`Connecting ${editor} globally...`);
    results.push(
      await provisionGlobal(
        {
          ...saved,
          ...(bootstrap ? { bootstrap_secret: bootstrap } : {}),
          client: editor,
          token_file: path.join(
            directory,
            `${editor}-${key(projectName)}.token`,
          ),
          expires_hours: 8760,
        },
        { home },
      ),
    );
  }
  await writeFile(profileFile, JSON.stringify(saved, null, 2) + "\n", {
    mode: 0o600,
  });
  if (!(await serviceReady(url)))
    throw Error(
      "The service stopped responding during setup. Restart setup to check PostgreSQL and start the service again.",
    );
  log(
    "READY: PostgreSQL and MCP service verified. Client connections configured. Reload/enable coordination in your client.",
  );
  log(
    "Open a Git repository: workspace registration is automatic. Use collaboration_list to find other repositories.",
  );
  log(`Private account details: ${profileFile}`);
  return {
    url: url.href,
    project: projectName,
    configurations: results.flatMap((r) => r.configurations),
    profile_file: profileFile,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      client: { type: "string" },
      project: { type: "string" },
      config: { type: "string" },
    },
  });
  if (values.config) {
    console.log(
      JSON.stringify(
        await provisionGlobal(JSON.parse(await privateFile(values.config))),
        null,
        2,
      ),
    );
    return;
  }
  await firstRun({
    url: values.url,
    client: values.client,
    project: values.project,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error("Setup: " + error.message);
    process.exitCode = 1;
  }
}
