import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Sqlite from "better-sqlite3";
import { database } from "../src/db.js";
import { Service } from "../src/service.js";
import {
  inspectImport,
  previewImport,
  applyImport,
  discoverLegacy,
} from "../src/import.js";
test("workspace migration requires complete reviewed mappings and preserves private context versions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workspace-import-")),
    source = path.join(root, "workspace.sqlite");
  const db = new Sqlite(source),
    w = randomUUID();
  db.exec(
    "CREATE TABLE workspaces(workspace_id TEXT);CREATE TABLE repos(workspace_id TEXT,repo_id TEXT);CREATE TABLE events(cursor INTEGER,workspace_id TEXT,repo_id TEXT,agent_id TEXT,timestamp TEXT,version INTEGER,kind TEXT,data TEXT);PRAGMA user_version=1",
  );
  db.prepare("INSERT INTO workspaces VALUES(?)").run(w);
  for (const repo of ["mobile", "backend"])
    db.prepare("INSERT INTO repos VALUES(?,?)").run(w, repo);
  for (const version of [1, 50])
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(
      version,
      w,
      "backend",
      "legacy-agent",
      "2026-01-01T00:00:00.000Z",
      version,
      "context",
      JSON.stringify({
        key: "login",
        content: "Contract v" + version,
        type: "api-contract",
      }),
    );
  db.close();
  const original = readFileSync(source);
  const pool = await database(process.env.TEST_DATABASE_URL),
    s = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  try {
    const project = await s.execute(owner, "project_create", {
      name: "Migration fixture",
    });
    const create = (name) =>
      s.execute(owner, "repo_create", {
        project_id: project.id,
        name,
        reference: "fixture:" + name,
      });
    const a = await create("Mobile"),
      b = await create("Backend");
    const plan = await inspectImport(
      source,
      path.join(root, "backups"),
      "workspace-source-" + randomUUID(),
    );
    assert.equal(discoverLegacy(root).length, 2);
    assert.ok(
      (await previewImport(pool, plan, { repositories: {} })).issues.length,
    );
    const mapping = {
      repositories: { [w + "/mobile"]: a.id, [w + "/backend"]: b.id },
    };
    const preview = await previewImport(pool, plan, mapping);
    assert.equal(preview.issues.length, 0);
    assert.equal(preview.proposed.length, 3);
    const bad = structuredClone(plan);
    bad.records.events[1].version = 1;
    assert.ok(
      (await previewImport(pool, bad, mapping)).issues.some((i) =>
        i.error.includes("Context key/version collision"),
      ),
    );
    await applyImport(pool, plan, mapping);
    assert.equal(
      (await previewImport(pool, plan, mapping)).already_imported,
      true,
    );
    const contexts = (await s.read(owner, "shared_context_items")).items.filter(
      (r) => r.repo_id === b.id,
    );
    assert.deepEqual(contexts.map((r) => r.context_version).sort(), [1, 50]);
    const continued = await s.execute(owner, "context_publish", {
      repo_id: b.id,
      key: "login",
      content: "After migration",
      permitted_repos: [b.id],
    });
    assert.equal(continued.context_version, 51);
    assert.ok(
      contexts.every(
        (c) => c.permitted_repos.length === 1 && c.permitted_repos[0] === b.id,
      ),
    );
    assert.equal(
      (await applyImport(pool, plan, mapping)).already_imported,
      true,
    );
    await assert.rejects(
      applyImport(pool, plan, {
        ...mapping,
        share_with: { [w + "/backend"]: [a.id] },
      }),
      /mapping changed/,
    );
    assert.deepEqual(readFileSync(source), original);
  } finally {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner import operations expose backup, reviewed mapping and explicit apply without reading outside configured root", async () => {
  const { Operations } = await import("../src/operations.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "import-ops-")),
    source = path.join(root, "repo.sqlite");
  const db = new Sqlite(source);
  db.exec(
    "CREATE TABLE agents(id TEXT,display_name TEXT);PRAGMA user_version=2",
  );
  db.prepare("INSERT INTO agents VALUES(?,?)").run(
    "legacy",
    "Historical agent",
  );
  db.close();
  const pool = await database(process.env.TEST_DATABASE_URL),
    s = new Service(pool),
    owner = { id: randomUUID(), owner: true };
  try {
    const ops = new Operations(pool, s, {
      importRoot: root,
      backupRoot: path.join(root, "backups"),
    });
    const project = await s.execute(owner, "project_create", {
        name: "Import API",
      }),
      repo = await s.execute(owner, "repo_create", {
        project_id: project.id,
        name: "Repo",
        reference: "fixture",
      });
    assert.throws(() => ops.source("../outside.sqlite"));
    await assert.rejects(ops.discover({ id: randomUUID() }), /Owner/);
    assert.equal((await ops.discover(owner)).items.length, 1);
    const plan = await ops.inspect(owner, {
      source: "repo.sqlite",
      source_id: "ops-source-" + randomUUID(),
    });
    assert.equal(plan.backup_created, true);
    await assert.rejects(
      ops.apply(owner, plan.id, { confirm: true }),
      /Review/,
    );
    const preview = await ops.review(owner, plan.id, { default_repo: repo.id });
    assert.equal(preview.issues.length, 0);
    await assert.rejects(ops.apply(owner, plan.id, { confirm: false }));
    const result = await ops.apply(owner, plan.id, { confirm: true });
    assert.equal(result.mapped, 1);
    assert.equal(
      (await ops.apply(owner, plan.id, { confirm: true })).already_imported,
      true,
    );
    assert.equal((await ops.status(owner)).backup_count, 1);
    const imported = (await s.read(owner, "agents")).items.find(
      (a) => a.legacy_id === "legacy" && a.legacy_source === plan.source_id,
    );
    assert.equal(imported.revoked, true);
    const enrollment = await s.execute(owner, "agent_enroll", {
      name: "Verified imported identity",
      existing_id: imported.id,
      grants: [{ repo_id: repo.id, permissions: ["task:read"] }],
    });
    assert.equal(enrollment.agent.id, imported.id);
    assert.equal((await s.authenticate(enrollment.token)).id, imported.id);
    await assert.rejects(
      s.execute(owner, "agent_enroll", {
        name: "Duplicate activation",
        existing_id: imported.id,
        grants: [{ repo_id: repo.id, permissions: ["task:read"] }],
      }),
      /Only inactive imported/,
    );
  } finally {
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed legacy schemas are rejected after a safe backup without changing originals", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "malformed-import-")),
    source = path.join(root, "bad.sqlite");
  const db = new Sqlite(source);
  db.exec("CREATE TABLE tasks(id TEXT);PRAGMA user_version=2");
  db.close();
  const before = readFileSync(source);
  try {
    await assert.rejects(
      inspectImport(source, path.join(root, "backups"), "malformed-source"),
      /Unsupported schema columns/,
    );
    assert.deepEqual(readFileSync(source), before);
    assert.equal(discoverLegacy(root).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
