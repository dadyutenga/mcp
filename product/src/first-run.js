import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  lstat,
  chmod,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { parseArgs, parseEnv } from "node:util";
import { createInterface, emitKeypressEvents } from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { endpoint, privateFile } from "./credentials.js";
import { gitWorkspace } from "./workspaces.js";
import { provisionGlobal } from "./global-setup.js";
import { selectedClients } from "./configuration.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const randomSecret = () => randomBytes(32).toString("hex");
const key = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.on("error", () =>
      reject(
        Error(`${command} is unavailable. Install it, then run setup again.`),
      ),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `${command} failed. Fix the error above, then run setup again.`,
            ),
          ),
    );
  });
}

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

async function readEnvironment(file) {
  const stat = await lstat(file).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!stat) return { text: "", values: {}, exists: false };
  if (
    stat.isFile() &&
    process.platform !== "win32" &&
    stat.uid === process.getuid()
  )
    await chmod(file, 0o600);
  const text = await privateFile(file);
  return { text, values: parseEnv(text), exists: true };
}

export async function prepareLocal({ root, url, execute = run }) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error(
      "Start the remote service first, then run setup with its HTTPS URL.",
    );
  if (url.protocol !== "http:" || url.hostname === "[::1]")
    throw Error(
      "Local Docker setup uses http://127.0.0.1:4310/mcp. Start HTTPS/IPv6 services separately, then reconnect.",
    );
  await execute("docker", ["info"], { stdio: "ignore" });
  await execute("docker", ["compose", "version"], { stdio: "ignore" });
  const file = path.join(root, "product", ".env");
  const { text, values, exists } = await readEnvironment(file);
  if (values.DATABASE_URL && !values.POSTGRES_PASSWORD)
    throw Error(
      "This installation uses local PostgreSQL. Run npm run start:local --prefix product in another terminal, then rerun setup.",
    );
  let content = text;
  for (const name of ["POSTGRES_PASSWORD", "BOOTSTRAP_SECRET"]) {
    if (
      !values[name] ||
      /replace_with|changeme|example|placeholder/i.test(values[name])
    ) {
      values[name] = randomSecret();
      const assignment = new RegExp(`^${name}=.*$`, "m");
      if (assignment.test(content))
        content = content.replace(assignment, `${name}=${values[name]}`);
      else
        content +=
          (content && !content.endsWith("\n") ? "\n" : "") +
          `${name}=${values[name]}\n`;
    }
  }
  if (
    values.COORDINATION_PORT &&
    values.COORDINATION_PORT !== (url.port || "80")
  )
    throw Error(
      "The existing Docker port differs from --url. Run setup with the configured service URL.",
    );
  if (!values.COORDINATION_PORT)
    content +=
      (content && !content.endsWith("\n") ? "\n" : "") +
      `COORDINATION_PORT=${url.port || "80"}\n`;
  if (content !== text)
    await writeFile(file, content, {
      mode: 0o600,
      ...(exists ? {} : { flag: "wx" }),
    });
  // A portable, existing directory avoids a platform-specific bind mount default.
  const imports = path.join(root, ".local", "legacy-imports");
  await mkdir(imports, { recursive: true });
  await execute(
    "docker",
    [
      "compose",
      "--project-directory",
      root,
      "--env-file",
      file,
      "up",
      "--build",
      "--wait",
    ],
    { cwd: root, env: { ...process.env, LEGACY_IMPORT_ROOT: imports } },
  );
  return values.BOOTSTRAP_SECRET;
}

export async function firstRun({
  root = projectRoot,
  home = os.homedir(),
  url: inputUrl,
  client,
  project,
  prompt = question,
  log = console.log,
  execute = run,
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
  let state = await reachable(url),
    bootstrap;
  if (!state) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error(
        "Service unavailable. Check the HTTPS URL and start the remote service first.",
      );
    if (
      (
        await prompt("Start the local service with Docker? y/n", "y")
      ).toLowerCase() !== "y"
    )
      throw Error("Start your service, then rerun node setup.mjs");
    log(
      "Preparing and starting the local service. The first Docker build can take a few minutes...",
    );
    bootstrap = await prepareLocal({ root, url, execute });
    state = await reachable(url);
    if (!state)
      throw Error(
        "Service is not ready. Check docker compose logs app, then rerun setup.",
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
      username: await prompt("Owner username", "operator"),
      password: await prompt("Owner password", "", { secret: true }),
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
  log(
    "Setup complete. Reload/enable coordination in your editor's MCP settings.",
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
