import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gitWorkspace } from "../src/workspaces.js";
import { globalClientConfiguration } from "../src/configuration.js";
test("workspace discovery finds the Git root from nested paths and file URIs without writing config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-roots-"));
  try {
    const repo = path.join(root, "repo with spaces");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await promisify(execFile)("git", ["init", repo]);
    const workspace = await gitWorkspace(
      pathToFileURL(path.join(repo, "src")).href,
    );
    assert.equal(workspace.name, "repo with spaces");
    assert.equal(workspace.reference.toLowerCase(), repo.toLowerCase());
    await assert.rejects(gitWorkspace(root), /Git repository/);
    await assert.rejects(gitWorkspace("relative/path"), /absolute/);
    assert.equal(globalClientConfiguration("cursor"), ".cursor/mcp.json");
    assert.equal(
      globalClientConfiguration("antigravity"),
      ".gemini/antigravity/mcp_config.json",
    );
    assert.throws(() => globalClientConfiguration("constructor"), /Choose/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
