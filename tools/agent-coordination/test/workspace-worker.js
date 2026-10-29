import { WorkspaceStore } from '../src/workspace.js';
const [file, workspace_id, repo_id, count] = process.argv.slice(2);
const store = new WorkspaceStore(file);
try {
  const actor = { workspace_id, repo_id, agent_id: 'worker' };
  for (let i = 0; i < Number(count); i++) store.publish({ workspace_id, from_repo: repo_id, key: 'race', content: `Contract ${i}`, type: 'contract' }, actor);
} finally { store.close(); }
