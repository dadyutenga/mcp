import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { renderClientConfiguration } from "../src/client-config.js";
import {
  selectedClients,
  globalClientConfiguration,
} from "../src/configuration.js";

const definition = {
  command: "C:\\Program Files\\nodejs\\node.exe",
  args: ["C:\\projects\\mcp\\product\\src\\bridge.js"],
  env: {
    COORDINATION_URL: "http://127.0.0.1:4310/mcp",
    COORDINATION_ENROLLMENT_TOKEN_FILE: "C:\\private\\enrollment.token",
    COORDINATION_CLIENT_NAME: "fixture",
  },
};

test("Codex and Grok TOML retain unrelated settings, large integers, other servers and Windows paths", () => {
  for (const client of ["codex", "grok"]) {
    const original = `# Saved in the backup before normalization\nmodel = "fixture-model"\nmaximum = 9223372036854775807\n[projects."C:\\\\my project"]\ntrust_level = "trusted"\n[mcp_servers.github]\ncommand = "existing-tool"\n`;
    const rendered = renderClientConfiguration(client, original, definition);
    const config = parse(rendered.content, { integersAsBigInt: "asNeeded" });
    assert.equal(config.model, "fixture-model");
    assert.equal(config.maximum, 9223372036854775807n);
    assert.equal(config.projects["C:\\my project"].trust_level, "trusted");
    assert.equal(config.mcp_servers.github.command, "existing-tool");
    assert.equal(config.mcp_servers.coordination.command, definition.command);
    assert.deepEqual(config.mcp_servers.coordination.args, definition.args);
    assert.deepEqual(
      { ...config.mcp_servers.coordination.env },
      definition.env,
    );
    assert.equal(config.mcp_servers.coordination.startup_timeout_sec, 30);
    assert.equal(
      renderClientConfiguration(client, rendered.content, definition).content,
      rendered.content,
    );
  }
});

test("Claude user JSON retains per-project state and other integrations while explicitly selecting stdio", () => {
  const original = {
    projects: { "/existing/repo": { hasTrustDialogAccepted: true } },
    theme: "dark",
    mcpServers: {
      github: { type: "http", url: "https://example.invalid/mcp" },
    },
  };
  const rendered = renderClientConfiguration(
    "claude",
    JSON.stringify(original),
    definition,
  );
  const config = JSON.parse(rendered.content);
  assert.deepEqual(config.projects, original.projects);
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.mcpServers.github, original.mcpServers.github);
  assert.equal(config.mcpServers.coordination.type, "stdio");
});

test("native client configuration rejects invalid syntax without printing embedded credentials or replacing unrelated services", () => {
  for (const [client, text] of [
    ["codex", 'password = "private-malformed-fixture'],
    ["claude", '{"password":"private-malformed-fixture'],
  ]) {
    assert.throws(
      () => renderClientConfiguration(client, text, definition),
      (error) =>
        /contents withheld/.test(error.message) &&
        !error.message.includes("private-malformed-fixture"),
    );
  }
  assert.throws(
    () =>
      renderClientConfiguration(
        "codex",
        '[mcp_servers.coordination]\ncommand="unrelated-tool"',
        definition,
      ),
    /review/,
  );
  assert.throws(
    () => renderClientConfiguration("grok", "mcp_servers = []", definition),
    /mcpServers object/,
  );
  assert.throws(
    () => renderClientConfiguration("claude", "[]", definition),
    /object/,
  );
});

test("multi-client selection supports aliases and legacy both without installing unspecified clients", () => {
  assert.deepEqual(selectedClients("codex, claude-code, grok-build,codex"), [
    "codex",
    "claude",
    "grok",
  ]);
  assert.deepEqual(selectedClients("both"), ["cursor", "antigravity"]);
  assert.deepEqual(selectedClients("all"), [
    "cursor",
    "antigravity",
    "codex",
    "claude",
    "grok",
  ]);
  assert.equal(globalClientConfiguration("codex"), ".codex/config.toml");
  assert.equal(globalClientConfiguration("claude"), ".claude.json");
  assert.equal(globalClientConfiguration("grok"), ".grok/config.toml");
  for (const value of ["constructor", "", "codex,unknown"])
    assert.throws(() => selectedClients(value), /Choose/);
});
