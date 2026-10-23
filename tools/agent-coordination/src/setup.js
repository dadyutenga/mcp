import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './db.js';

const root = projectRoot();
const serverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
const name = 'local-agent-coordination';
const definition = { command: process.execPath, args: [serverScript] };

const configurations = ['.cursor/mcp.json', '.agents/mcp_config.json'].map(relative => {
  const target = path.join(root, relative);
  const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
  if (current.mcpServers && (typeof current.mcpServers !== 'object' || Array.isArray(current.mcpServers))) {
    throw new Error(`${target}: mcpServers must be an object`);
  }
  const existing = current.mcpServers?.[name];
  if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
    throw new Error(`${target}: ${name} already exists with different settings; merge it manually`);
  }
  current.mcpServers = { ...current.mcpServers, [name]: definition };
  return { target, current };
});

for (const { target, current } of configurations) {
  mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(staging, target);
  console.log(`Configured ${target}`);
}

const gitignore = path.join(root, '.gitignore');
const ignoreRules = ['/.local/agent-coordination/', '/tools/agent-coordination/node_modules/',
  '/.cursor/mcp.json', '/.agents/mcp_config.json'];
let existingIgnore = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
for (const rule of ignoreRules) {
  if (!existingIgnore.split(/\r?\n/).includes(rule)) {
    existingIgnore += `${existingIgnore && !existingIgnore.endsWith('\n') ? '\n' : ''}${rule}\n`;
  }
}
if (existingIgnore !== (existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '')) {
  writeFileSync(gitignore, existingIgnore);
  console.log(`Updated ${gitignore}`);
}
