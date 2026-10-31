import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { firstRun } from "../src/first-run.js";
import { database } from "../src/db.js";
import { app } from "../src/server.js";
import { parse } from "smol-toml";
import { VERSION } from "../src/version.js";

test("one-command setup bootstraps a first owner, installs all five clients and resumes without re-enrollment", async () => {
  const pool = await database(process.env.TEST_DATABASE_URL);
  await pool.query("TRUNCATE users CASCADE");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-first-user-"));
  const home = path.join(root, "home"),
    repo = path.join(root, "checkout");
  const bootstrap = "first-run-fixture-bootstrap-secret-at-least-32";
  const project = "First run " + randomUUID();
  const server = await app({
    pool,
    bootstrapSecret: bootstrap,
    runtimeConfig: null,
  });
  try {
    await mkdir(home);
    await mkdir(path.join(home, ".codex"));
    const originalCodex =
      '# Keep a backup of this comment\nmodel = "fixture-model"\n[mcp_servers.github]\ncommand = "existing-tool"\n';
    await writeFile(path.join(home, ".codex", "config.toml"), originalCodex);
    const originalClaude = {
      theme: "dark",
      projects: { "/existing": { hasTrustDialogAccepted: true } },
    };
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(originalClaude),
    );
    await mkdir(path.join(repo, "product"), { recursive: true });
    await promisify(execFile)("git", ["init", repo]);
    await writeFile(
      path.join(repo, "product", ".env"),
      `BOOTSTRAP_SECRET=${bootstrap}\n`,
      { mode: 0o600 },
    );
    await server.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${server.server.address().port}/mcp`;
    const logs = [];
    const options = {
      root: repo,
      home,
      url,
      client: "all",
      project,
      prompt: async () => {
        throw Error(
          "Fresh local setup must not ask for passwords or bootstrap values",
        );
      },
      startLocalService: async () => {
        throw Error("An existing service must not be started twice");
      },
      log: (value) => logs.push(value),
    };
    const result = await firstRun(options);
    assert.equal(result.configurations.length, 5);
    assert.equal(
      await readFile(
        path.join(home, ".codex", "config.toml.coordination-backup"),
        "utf8",
      ),
      originalCodex,
    );
    assert.equal(
      parse(await readFile(path.join(home, ".codex", "config.toml"), "utf8"))
        .model,
      "fixture-model",
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"))
        .projects,
      originalClaude.projects,
    );
    const owner = JSON.parse(await readFile(result.profile_file, "utf8"));
    assert.equal(owner.username, "operator");
    assert.equal(owner.project, project);
    assert.match(owner.password, /^[a-f0-9]{64}$/);
    assert.ok(!logs.join("\n").includes(owner.password));
    assert.ok(!logs.join("\n").includes(bootstrap));
    assert.equal(owner.bootstrap_secret, undefined);
    const rows = (
      await pool.query(
        "SELECT count(*) FROM agents WHERE body->'enrollment'->>'project_id'=(SELECT id::text FROM projects WHERE body->>'name'=$1)",
        [project],
      )
    ).rows;
    assert.equal(rows[0].count, "5");
    assert.deepEqual(await firstRun(options), result);
    assert.equal(
      (await pool.query("SELECT count(*) FROM users")).rows[0].count,
      "1",
    );
    assert.deepEqual((await readdir(repo)).sort(), [".git", "product"]);
    for (const config of result.configurations) {
      const text = await readFile(config, "utf8");
      assert.ok(!text.includes(owner.password));
      const servers = config.endsWith(".toml")
        ? parse(text).mcp_servers
        : JSON.parse(text).mcpServers;
      assert.ok(servers.coordination.env.COORDINATION_ENROLLMENT_TOKEN_FILE);
    }
    const output = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../setup.mjs", import.meta.url)),
      "--help",
    ]);
    assert.match(output.stdout, /node setup.mjs/);
    const version = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../setup.mjs", import.meta.url)),
      "--version",
    ]);
    assert.equal(version.stdout.trim(), VERSION);
    assert.equal(
      (await (await fetch(new URL("/", url))).json()).version,
      VERSION,
    );
  } finally {
    await server.close();
    // These installation-only fixtures have no repository/task dependencies.
    await pool.query(
      "DELETE FROM agent_tokens WHERE agent_id IN (SELECT id FROM agents WHERE body->'enrollment'->>'project_id'=(SELECT id::text FROM projects WHERE body->>'name'=$1))",
      [project],
    );
    await pool.query(
      "DELETE FROM agents WHERE body->'enrollment'->>'project_id'=(SELECT id::text FROM projects WHERE body->>'name'=$1)",
      [project],
    );
    await pool.query("DELETE FROM projects WHERE body->>'name'=$1", [project]);
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
