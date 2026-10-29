import path from 'node:path';
import { projectRoot } from './db.js';
import { WorkspaceStore, workspaceSchemas, workspaceDatabasePath } from './workspace.js';

// Lazy initialization keeps unconfigured single-repo sessions entirely local.
export function registerWorkspaceTools(tool, actor, { env = process.env } = {}) {
  let store;
  let workspaceId = env.AGENT_COORDINATION_WORKSPACE_ID || null;
  let repoId = env.AGENT_COORDINATION_REPO_ID || null;
  const db = () => {
    if (store) return store;
    const file = workspaceDatabasePath(env);
    const relative = path.relative(projectRoot(), file);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Workspace database must be outside the current repo; configure AGENT_COORDINATION_WORKSPACE_DB');
    }
    return store = new WorkspaceStore(file, {
      staleMinutes: Number(env.AGENT_COORDINATION_STALE_MINUTES || 15),
    });
  };
  const session = () => {
    const agent_id = actor();
    if (!workspaceId || !repoId) throw new Error('Call workspace_join first or configure AGENT_COORDINATION_WORKSPACE_ID and AGENT_COORDINATION_REPO_ID');
    return { workspace_id: workspaceId, repo_id: repoId, agent_id };
  };
  const scoped = method => x => { const current = session(); return db()[method](x, current); };
  const register = (name, description, run) => tool(name, description, workspaceSchemas[name], run);
  register('workspace_create', 'Create a named workspace in the central store. Join it next; existing repo tools stay local.', x => { const agent_id = actor(); return db().create(x, { agent_id, repo_id: repoId || 'local' }); });
  register('workspace_join', 'Register this session’s repo in a workspace. A session cannot switch repo or workspace identity.', x => {
    const agentId = actor();
    if ((workspaceId && workspaceId !== x.workspace_id) || (repoId && repoId !== x.repo_id)) throw new Error('Workspace or repo does not match this session; start a separate session');
    const result = db().join(x, agentId);
    workspaceId = x.workspace_id; repoId = x.repo_id;
    return result;
  });
  register('workspace_list_repos', 'List linked repos, registration metadata and last-active times. Paginate with after_repo.', scoped('listRepos'));
  register('status_post', 'Publish your repo/agent status. Likely secrets are rejected; refresh at least every 15 minutes by default.', scoped('postStatus'));
  register('status_get', 'Read latest status per agent, with stale flags and bounded summaries. Paginate with after.', scoped('getStatus'));
  register('context_publish', 'Append an immutable context version. Publish contracts and variable names, never secret values.', scoped('publish'));
  register('context_get', 'Read context history. since accepts an ISO timestamp or a context version (numeric since requires key and from_repo). Summaries by default; full=true retrieves bounded content. Paginate with after.', scoped('getContext'));
  register('handoff_send', 'Send a durable request to another joined repo. Priority 1–5, with 5 highest.', scoped('send'));
  register('handoff_inbox', 'Read incoming handoffs; defaults to open. Use state=acknowledged, resolved or all, and after for pagination.', scoped('inbox'));
  register('handoff_ack', 'Acknowledge an incoming handoff; only its destination repo may do so.', x => { const current = session(); return db().transition(x, current, 'acknowledged'); });
  register('handoff_resolve', 'Resolve an incoming handoff; only its destination repo may do so.', x => { const current = session(); return db().transition(x, current, 'resolved'); });
  register('changes_since', 'Read other repos’ events after an opaque workspace cursor; persist the returned cursor and repeat while has_more.', scoped('changes'));
  return { close: () => { store?.close(); store = undefined; } };
}
