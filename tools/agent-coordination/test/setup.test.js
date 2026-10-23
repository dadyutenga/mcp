import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('setup preserves other MCP servers and reset needs explicit flag', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-setup-'));
  try {
    mkdirSync(path.join(root, '.cursor'));
    writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { existing: { command: 'example', args: [] } }, customSetting: true
    }));
    const env = { ...process.env, AGENT_COORDINATION_PROJECT_ROOT: root };
    const setup = spawnSync(process.execPath, [path.join(serviceRoot, 'src', 'setup.js')], { env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const cursor = JSON.parse(readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'));
    const antigravity = JSON.parse(readFileSync(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
    assert.equal(cursor.customSetting, true);
    assert.equal(cursor.mcpServers.existing.command, 'example');
    assert.deepEqual(cursor.mcpServers['local-agent-coordination'], antigravity.mcpServers['local-agent-coordination']);
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const rule of ['/.local/agent-coordination/', '/.cursor/mcp.json', '/.agents/mcp_config.json']) {
      assert.ok(ignore.includes(rule));
    }
    const refused = spawnSync(process.execPath, [path.join(serviceRoot, 'src', 'cli.js'), 'reset'], { env, encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Reset refused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
