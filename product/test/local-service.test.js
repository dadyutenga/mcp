import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { firstRun } from "../src/first-run.js";
import { database } from "../src/db.js";
import { app } from "../src/server.js";
import {
  postgresURL,
  verifyPostgres,
  prepareLocal,
  startLocalService,
  serviceReady,
} from "../src/local-service.js";
import { fileURLToPath } from "node:url";
import pg from "pg";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("setup starts through PostgreSQL without Docker and proves the MCP connection works", async () => {
  const connection = new URL(process.env.TEST_DATABASE_URL);
  const pool = await database(connection.href);
  await pool.query("TRUNCATE users CASCADE");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "coordination-native-"));
  const root = path.join(fixture, "checkout"),
    home = path.join(fixture, "home");
  const port = await freePort(),
    prompts = [],
    logs = [];
  let server;
  try {
    await mkdir(path.join(root, "product"), { recursive: true });
    await mkdir(home);
    await promisify(execFile)("git", ["init", root]);
    const result = await firstRun({
      root,
      home,
      url: `http://127.0.0.1:${port}/mcp`,
      client: "codex",
      project: "Native " + randomUUID(),
      log: (line) => logs.push(line),
      prompt: async (label, fallback, options = {}) => {
        prompts.push(label);
        assert.doesNotMatch(
          label,
          /docker/i,
          "Docker must not be part of setup",
        );
        if (/PostgreSQL host/i.test(label)) return connection.hostname;
        if (/PostgreSQL port/i.test(label)) return connection.port || "5432";
        if (/database name/i.test(label))
          return decodeURIComponent(connection.pathname.slice(1));
        if (/PostgreSQL username/i.test(label))
          return decodeURIComponent(connection.username);
        if (/PostgreSQL password/i.test(label)) {
          assert.equal(options.secret, true);
          return decodeURIComponent(connection.password);
        }
        return fallback;
      },
      startLocalService: async ({ environment }) => {
        server = await app({
          pool,
          bootstrapSecret: environment.BOOTSTRAP_SECRET,
          runtimeConfig: null,
        });
        await server.listen({ host: "127.0.0.1", port });
        return { pid: process.pid, log_file: "fixture-service.log" };
      },
    });
    assert.equal(result.configurations.length, 1);
    assert.ok(prompts.some((p) => /PostgreSQL password/i.test(p)));
    assert.match(logs.join("\n"), /PostgreSQL connection verified/);
    assert.match(logs.join("\n"), /READY/);
    assert.ok(
      !logs.join("\n").includes(decodeURIComponent(connection.password)),
    );
  } finally {
    await server?.close();
    await pool.end();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("PostgreSQL URL handling encodes credentials and rejects invalid parameters", () => {
  const password = 'synthetic:@ /?#%"credential';
  const url = postgresURL({
    host: "127.0.0.1",
    port: "5432",
    database: "coordination",
    username: "fixture-user",
    password,
  });
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.searchParams.get("sslmode"), "disable");
  for (const input of [
    { port: "bad" },
    { host: "http://localhost" },
    { password: "" },
    { password: "postgres" },
  ])
    assert.throws(() =>
      postgresURL({
        host: "127.0.0.1",
        port: "5432",
        database: "coordination",
        username: "fixture",
        password,
        ...input,
      }),
    );
});

test("wrong PostgreSQL passwords fail clearly without disclosing credentials", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const password = "synthetic-wrong-" + randomUUID();
  url.password = password;
  await assert.rejects(
    verifyPostgres(url, { prompt: async () => "y", log: () => {} }),
    (error) =>
      /rejected the username\/password/.test(error.message) &&
      !error.message.includes(password),
  );
});

test("setup creates an explicitly selected missing database and verifies it", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL),
    name = "coordination_created_" + randomUUID().replaceAll("-", "");
  url.pathname = "/" + name;
  const client = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await client.connect();
  const prompts = [],
    logs = [];
  try {
    await verifyPostgres(url, {
      prompt: async (label) => {
        prompts.push(label);
        return "y";
      },
      log: (line) => logs.push(line),
    });
    assert.equal(prompts.length, 1);
    assert.match(logs.join("\n"), /Created PostgreSQL database/);
  } finally {
    assert.match(name, /^coordination_created_[a-f0-9]{32}$/);
    await client.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await client.end();
  }
});

test("native startup runs the actual Node service, verifies health and reuses saved settings", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "coordination-process-"),
  );
  const root = path.join(fixture, "checkout"),
    directory = path.join(fixture, "private");
  const connection = new URL(process.env.TEST_DATABASE_URL),
    url = new URL(`http://127.0.0.1:${await freePort()}/mcp`);
  let state;
  try {
    await mkdir(path.join(root, "product"), { recursive: true });
    const prompt = async (label, fallback) => {
      if (/host/i.test(label)) return connection.hostname;
      if (/port/i.test(label)) return connection.port || "5432";
      if (/database name/i.test(label))
        return decodeURIComponent(connection.pathname.slice(1));
      if (/username/i.test(label))
        return decodeURIComponent(connection.username);
      if (/password/i.test(label))
        return decodeURIComponent(connection.password);
      return fallback;
    };
    state = await prepareLocal({
      root,
      url,
      directory,
      prompt,
      log: () => {},
      start: (input) =>
        startLocalService({
          ...input,
          entry: fileURLToPath(new URL("../src/server.js", import.meta.url)),
        }),
    });
    assert.ok(state.pid > 0 && state.pid !== process.pid);
    assert.equal(await serviceReady(url), true);
    const envFile = path.join(root, "product", ".env"),
      before = await readFile(envFile, "utf8");
    const again = await prepareLocal({
      root,
      url,
      directory,
      prompt: async () => {
        throw Error("Saved credentials should be reused");
      },
      log: () => {},
      start: async () => ({ pid: state.pid }),
    });
    assert.equal(again.pid, state.pid);
    assert.equal(await readFile(envFile, "utf8"), before);
    assert.equal((before.match(/^DATABASE_URL=/gm) || []).length, 1);
    const saved = JSON.parse(
      await readFile(path.join(directory, "service.json"), "utf8"),
    );
    assert.equal(saved.pid, state.pid);
    assert.ok(
      !JSON.stringify(saved).includes(decodeURIComponent(connection.password)),
    );
  } finally {
    if (state?.pid) process.kill(state.pid);
    for (let attempt = 0; attempt < 20 && (await serviceReady(url)); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(fixture, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
