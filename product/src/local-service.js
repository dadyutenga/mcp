import { mkdir, writeFile, lstat, chmod, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import path from "node:path";
import pg from "pg";
import { privateFile } from "./credentials.js";

export const POSTGRES_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: "5432",
  database: "coordination",
  username: "postgres",
});
const loopback = (host) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);

export async function readEnvironment(file) {
  const stat = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
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

export function postgresURL({ host, port, database, username, password }) {
  if (
    !/^[\w.:[\]-]+$/.test(host) ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw Error(
      "Enter a PostgreSQL hostname/IP and a port between 1 and 65535.",
    );
  if (
    !database ||
    Buffer.byteLength(database) > 63 ||
    /[\x00-\x1f\x7f]/.test(database) ||
    !username ||
    /[\x00-\x1f\x7f]/.test(username)
  )
    throw Error(
      "Enter a database name (up to 63 bytes) and PostgreSQL username.",
    );
  if (
    !password ||
    /replace_with|changeme|^(?:password|postgres|example)$/i.test(password)
  )
    throw Error(
      "Enter your actual PostgreSQL password. A non-default password is required.",
    );
  const url = new URL("postgresql://127.0.0.1");
  url.hostname =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  url.port = port;
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  url.pathname = "/" + encodeURIComponent(database);
  url.searchParams.set("sslmode", loopback(host) ? "disable" : "require");
  return url;
}

function connectionError(error, url) {
  const target = `${url.hostname}:${url.port || "5432"}`;
  if (["28P01", "28000"].includes(error.code))
    return Error(
      `PostgreSQL rejected the username/password at ${target}. Check your PostgreSQL account credentials, then rerun setup.`,
    );
  if (
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(
      error.code,
    ) ||
    /timeout/i.test(error.message || "")
  )
    return Error(
      `Cannot reach PostgreSQL at ${target}. Start PostgreSQL and check the host/port, then rerun setup.`,
    );
  if (error.code === "42501")
    return Error(
      "The PostgreSQL user cannot create this database. Choose an existing database you own, or use a PostgreSQL user with CREATEDB permission.",
    );
  return Error(
    `Could not use PostgreSQL at ${target}. Check the database name, account permissions and TLS settings. Connection details are withheld.`,
  );
}

async function queryVersion(url) {
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    await client.connect();
    return (
      await client.query(
        "SELECT current_setting('server_version_num')::integer AS version",
      )
    ).rows[0].version;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function verifyPostgres(url, { prompt, log }) {
  let version;
  try {
    version = await queryVersion(url);
  } catch (error) {
    if (error.code !== "3D000") throw connectionError(error, url);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (
      (
        await prompt(`Database ${name} does not exist. Create it? y/n`, "y")
      ).toLowerCase() !== "y"
    )
      throw Error("Choose an existing PostgreSQL database and rerun setup.");
    const maintenance = new URL(url);
    maintenance.pathname = "/postgres";
    const client = new pg.Client({
      connectionString: maintenance.href,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      await client.connect();
      try {
        await client.query(
          'CREATE DATABASE "' + name.replaceAll('"', '""') + '"',
        );
      } catch (error) {
        if (error.code !== "42P04") throw error;
      }
      log(`Created PostgreSQL database ${name}.`);
    } catch (error) {
      throw connectionError(error, url);
    } finally {
      await client.end().catch(() => {});
    }
    try {
      version = await queryVersion(url);
    } catch (error) {
      throw connectionError(error, url);
    }
  }
  if (version < 160000)
    throw Error(
      "PostgreSQL 16 or newer is required. Connect to a supported PostgreSQL server.",
    );
  log(
    `PostgreSQL connection verified (version ${Math.floor(version / 10000)}).`,
  );
}

export async function serviceReady(url) {
  try {
    const metadata = await fetch(new URL("/", url), {
      signal: AbortSignal.timeout(1500),
    });
    if (
      !metadata.ok ||
      (await metadata.json()).service !== "agent-coordination"
    )
      return false;
    const ready = await fetch(new URL("/api/v1/health/ready", url), {
      signal: AbortSignal.timeout(1500),
    });
    return ready.ok && (await ready.json()).ready === true;
  } catch {
    return false;
  }
}

export async function startLocalService({
  root,
  url,
  directory,
  environment,
  timeoutMs = 30000,
  entry = path.join(root, "product", "src", "server.js"),
}) {
  const logFile = path.join(directory, "service.log");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = await open(logFile, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: path.join(root, "product"),
      env: { ...process.env, ...environment },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(
          Error(
            `Could not launch the service. Check your Node.js installation. Log: ${logFile}`,
          ),
        ),
      );
    });
    child.unref();
  } finally {
    await output.close();
  }
  let verified = false;
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await serviceReady(url)) {
        const state = {
          pid: child.pid,
          url: url.href,
          root,
          log_file: logFile,
          started_at: new Date().toISOString(),
        };
        await writeFile(
          path.join(directory, "service.json"),
          JSON.stringify(state, null, 2) + "\n",
          { mode: 0o600 },
        );
        verified = true;
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error(
      `The service did not become ready at ${url.href}. PostgreSQL settings were saved. Check port ${url.port || "80"} and the private log: ${logFile}`,
    );
  } finally {
    if (!verified) child.kill();
  }
}

export async function prepareLocal({
  root,
  url,
  directory,
  prompt,
  log = console.log,
  start = startLocalService,
}) {
  if (
    !loopback(url.hostname) ||
    url.hostname === "[::1]" ||
    url.protocol !== "http:"
  )
    throw Error(
      "Automatic local startup uses http://127.0.0.1:4310/mcp. Connect to an already running service for other URLs.",
    );
  const file = path.join(root, "product", ".env");
  const { text, values, exists } = await readEnvironment(file);
  let connection;
  if (values.DATABASE_URL) {
    try {
      connection = new URL(values.DATABASE_URL);
    } catch {
      throw Error(
        "Saved PostgreSQL URL is invalid. Repair product/.env or remove that unused configuration and rerun setup.",
      );
    }
    if (
      !["postgres:", "postgresql:"].includes(connection.protocol) ||
      !connection.password
    )
      throw Error(
        "Saved PostgreSQL configuration requires a connection URL with an account password.",
      );
    log(
      `Using saved PostgreSQL connection at ${connection.hostname}:${connection.port || "5432"}.`,
    );
  } else {
    log(
      "Connect to your running PostgreSQL server. The PostgreSQL password is entered separately and hidden.",
    );
    log(
      "Default database URL: postgresql://postgres@127.0.0.1:5432/coordination",
    );
    connection = postgresURL({
      host: await prompt("PostgreSQL host", POSTGRES_DEFAULTS.host),
      port: await prompt("PostgreSQL port", POSTGRES_DEFAULTS.port),
      database: await prompt(
        "PostgreSQL database name",
        POSTGRES_DEFAULTS.database,
      ),
      username: await prompt("PostgreSQL username", POSTGRES_DEFAULTS.username),
      password: await prompt("PostgreSQL password", "", { secret: true }),
    });
  }
  await verifyPostgres(connection, { prompt, log });
  const bootstrap =
    values.BOOTSTRAP_SECRET?.length >= 24 &&
    !/replace_with|changeme|placeholder|example/i.test(values.BOOTSTRAP_SECRET)
      ? values.BOOTSTRAP_SECRET
      : randomBytes(32).toString("hex");
  const settings = {
    DATABASE_URL: connection.href,
    BOOTSTRAP_SECRET: bootstrap,
    HOST: "127.0.0.1",
    PORT: url.port || "80",
  };
  let content = text;
  for (const [name, value] of Object.entries(settings)) {
    const assignment = new RegExp(`^${name}[ \t]*=.*$`, "m");
    const line = `${name}=${JSON.stringify(value)}`;
    content = assignment.test(content)
      ? content.replace(assignment, () => line)
      : content +
        (content && !content.endsWith("\n") ? "\n" : "") +
        line +
        "\n";
  }
  await writeFile(file, content, {
    mode: 0o600,
    ...(exists ? {} : { flag: "wx" }),
  });
  log(`Starting the coordination service at ${url.href}...`);
  const processState = await start({
    root,
    url,
    directory,
    environment: { ...values, ...settings },
  });
  if (!(await serviceReady(url)))
    throw Error(
      "Service startup could not be verified. Check the saved PostgreSQL settings and service log.",
    );
  log(`Service health verified at ${url.href}.`);
  return { bootstrap, ...processState };
}
