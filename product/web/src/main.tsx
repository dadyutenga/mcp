import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Row = Record<string, any>;
const resources = [
  "projects",
  "repositories",
  "agents",
  "agent_tokens",
  "agent_repo_grants",
  "tasks",
  "task_events",
  "task_dependencies",
  "file_reservations",
  "cross_repo_requests",
  "cross_repo_responses",
  "shared_context_items",
  "imports",
  "import_plans",
];
const pages: Record<string, string> = {
  Overview: "",
  Projects: "projects",
  Repositories: "repositories",
  Agents: "agents",
  Tasks: "tasks",
  "Cross-repo inbox": "cross_repo_requests",
  Reservations: "file_reservations",
  Context: "shared_context_items",
  Activity: "",
  Settings: "",
};
const permissions = [
  "task:read",
  "task:claim",
  "task:update",
  "task:comment",
  "reservation:acquire",
  "reservation:release",
  "context:read",
  "context:publish",
  "cross_repo:request",
  "cross_repo:approve",
];
const operations: Record<string, Record<string, string>> = {
  project_create: { name: "text", description: "textarea" },
  repo_create: {
    project_id: "projects",
    name: "text",
    reference: "text",
    default_branch: "text",
    case_sensitive: "boolean",
  },
  record_update: {
    kind: "kind",
    id: "text",
    version: "number",
    name: "text?",
    status: "archive",
  },
  project_edit: {
    id: "projects",
    version: "number",
    name: "text",
    description: "textarea",
    status: "archive",
  },
  repo_edit: {
    id: "repositories",
    version: "number",
    name: "text",
    reference: "text",
    default_branch: "text",
    case_sensitive: "boolean",
    status: "archive",
  },
  agent_enroll: {
    name: "text",
    existing_id: "agents?",
    repo_id: "repositories",
    permissions: "permissions",
  },
  agent_rotate: { id: "agents" },
  agent_revoke: { id: "agents" },
  token_revoke: { id: "agent_tokens" },
  grant_set: {
    agent_id: "agents",
    repo_id: "repositories",
    permissions: "permissions",
    reason: "text",
    expires_at: "datetime?",
  },
  task_create: {
    repo_id: "repositories",
    title: "text",
    description: "textarea",
    priority: "number",
    assignee: "agents?",
    due_at: "datetime?",
  },
  task_update: {
    id: "tasks",
    version: "number",
    state: "state",
    progress: "number",
    title: "text?",
    description: "text?",
    priority: "number?",
    due_at: "datetime?",
  },
  task_comment: { id: "tasks", comment: "textarea" },
  task_handoff: {
    id: "tasks",
    version: "number",
    to_agent: "agents",
    reason: "text",
  },
  dependency_add: { id: "tasks", depends_on: "tasks" },
  dependency_remove: { id: "task_dependencies" },
  request_create: {
    repo_id: "repositories",
    target_repo: "repositories",
    task_id: "tasks?",
    reason: "text",
    scope: "text",
    type: "request_type",
    format: "text",
  },
  request_clarify: {
    id: "cross_repo_requests",
    clarification: "textarea",
    scope: "text?",
  },
  request_decide: {
    id: "cross_repo_requests",
    decision: "decision",
    reason: "text",
  },
  request_answer: {
    id: "cross_repo_requests",
    content: "textarea",
    reference_path: "text?",
    reference_commit: "text?",
  },
  reservation_release: { id: "file_reservations" },
  context_publish: {
    repo_id: "repositories",
    key: "text",
    content: "textarea",
    permitted_repos: "repo_ids",
  },
};
const choices: Record<string, string[]> = {
  state: ["ready", "in_progress", "blocked", "review", "done", "cancelled"],
  request_type: ["api-contract", "excerpt", "test-result", "decision", "help"],
  decision: ["approved", "denied", "needs-input", "revoked"],
  kind: ["projects", "repositories"],
  archive: ["active", "archived"],
};
const human = (s: string) => s.replaceAll("_", " ");
const date = (s: string) => new Date(s).toLocaleString();
function App() {
  const [csrf, setCsrf] = useState(""),
    [setup, setSetup] = useState(false),
    [page, setPage] = useState("Overview"),
    [data, setData] = useState<Record<string, Row[]>>({}),
    [audit, setAudit] = useState<Row[]>([]),
    [settings, setSettings] = useState<Row>({}),
    [ops, setOps] = useState<Row>({}),
    [error, setError] = useState(""),
    [refreshError, setRefreshError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [action, setAction] = useState(""),
    [defaults, setDefaults] = useState<Row>({}),
    [credential, setCredential] = useState(""),
    [stamp, setStamp] = useState(""),
    [search, setSearch] = useState(""),
    [online, setOnline] = useState(navigator.onLine),
    [live, setLive] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [board, setBoard] = useState(false),
    [sources, setSources] = useState<Row[]>([]),
    [importPlan, setImportPlan] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [importResult, setImportResult] = useState<Row | null>(null),
    [sessions, setSessions] = useState<Row[]>([]),
    [historyKind, setHistoryKind] = useState("messages"),
    [historyPage, setHistoryPage] = useState<Row | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const refreshing = useRef(false),
    pendingRefresh = useRef(false);
  const api = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const r = await fetch("/api/v1/" + url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          ...options.headers,
        },
      });
      const j = await r.json();
      if (!r.ok) {
        if (r.status === 401 && csrf) setCsrf("");
        throw Error(j.error?.message || "Request failed");
      }
      return j;
    },
    [csrf],
  );
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      pendingRefresh.current = true;
      return;
    }
    refreshing.current = true;
    setLoading(true);
    try {
      do {
        pendingRefresh.current = false;
        const entries = await Promise.all(
          resources.map(async (k) => {
            let after = "";
            const rows: Row[] = [];
            for (;;) {
              const p = await api("resources/" + k + "?after=" + after);
              rows.push(...p.items);
              if (!p.has_more) break;
              if (p.next_cursor === after)
                throw Error("Resource cursor did not advance");
              after = p.next_cursor;
            }
            return [k, rows] as const;
          }),
        );
        setData(Object.fromEntries(entries));
        const events: Row[] = [];
        let after = 0;
        for (;;) {
          const next = await api("notifications?after=" + after);
          events.push(...next);
          if (next.length < 100) break;
          after = Number(next.at(-1).id);
        }
        setAudit(events);
        setSettings(await api("settings"));
        setOps(await api("operations"));
        setSessions(await api("auth/sessions"));
        setStamp(new Date().toLocaleTimeString());
        setRefreshError("");
      } while (pendingRefresh.current);
    } catch (e) {
      setRefreshError(String(e));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    api("auth/setup")
      .then((x) => setSetup(x.bootstrap_required))
      .catch((e) => setError(String(e)));
    api("auth/me")
      .then((x) => setCsrf(x.csrf))
      .catch(() => {});
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!csrf) return;
    refresh();
    const es = new EventSource("/api/v1/events");
    let debounce: ReturnType<typeof setTimeout>;
    es.onopen = () => setLive(true);
    es.onmessage = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 100);
    };
    es.onerror = () => setLive(false);
    const timer = setInterval(refresh, 15000);
    return () => {
      clearTimeout(debounce);
      es.close();
      clearInterval(timer);
    };
  }, [csrf, refresh]);
  async function run(action: string, input: Row) {
    return api("actions/" + action, {
      method: "POST",
      headers: ["agent_enroll", "agent_rotate"].includes(action)
        ? {}
        : { "Idempotency-Key": requestKey.current },
      body: JSON.stringify(input),
    });
  }
  function openAction(name: string, values: Row = {}) {
    requestKey.current = crypto.randomUUID();
    const fields = { ...values };
    for (const key of ["due_at", "expires_at"])
      if (fields[key]) {
        const date = new Date(fields[key]);
        fields[key] = new Date(
          date.getTime() - date.getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16);
      }
    setDefaults(fields);
    setAction(name);
    setError("");
  }
  async function signin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (setup) {
        await api("auth/bootstrap", {
          method: "POST",
          body: JSON.stringify(f),
        });
        setSetup(false);
      }
      const r = await api("auth/session", {
        method: "POST",
        body: JSON.stringify({ username: f.username, password: f.password }),
      });
      setCsrf(r.csrf);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget),
      f: Row = Object.fromEntries(form);
    for (const [k, t] of Object.entries(operations[action])) {
      if (!f[k] && t.endsWith("?")) delete f[k];
      else if (t.replace("?", "") === "number") f[k] = Number(f[k]);
      else if (t.replace("?", "") === "datetime")
        f[k] = new Date(f[k]).toISOString();
      else if (t === "boolean") f[k] = f[k] === "true";
      else if (["permissions", "repo_ids"].includes(t)) f[k] = form.getAll(k);
    }
    if (action === "agent_enroll") {
      f.grants = [{ repo_id: f.repo_id, permissions: f.permissions }];
      delete f.repo_id;
      delete f.permissions;
    }
    if (action === "request_answer") {
      if (f.reference_path || f.reference_commit)
        f.reference = { path: f.reference_path, commit: f.reference_commit };
      delete f.reference_path;
      delete f.reference_commit;
    }
    try {
      let operation = action;
      if (["project_edit", "repo_edit"].includes(action)) {
        operation = "record_update";
        f.kind = action === "project_edit" ? "projects" : "repositories";
      }
      const r = await run(operation, f);
      if (r.token) setCredential(r.token);
      setAction("");
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const label = (kind: string, id: string) =>
    data[kind]?.find((r) => r.id === id)?.name ||
    data[kind]?.find((r) => r.id === id)?.title ||
    id;
  async function viewRecord(resource: string, record: Row) {
    try {
      setSelected({
        ...(await api("resources/" + resource + "/" + record.id)),
        resource,
      });
    } catch (e) {
      setError(String(e));
    }
  }
  async function loadHistory(after = "") {
    setBusy(true);
    try {
      setHistoryPage(await api("resources/" + historyKind + "?after=" + after));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const repoName = (id: string) => label("repositories", id);
  const createAction: Record<string, string> = {
    Projects: "project_create",
    Repositories: "repo_create",
    Agents: "agent_enroll",
    Tasks: "task_create",
    "Cross-repo inbox": "request_create",
    Context: "context_publish",
  };
  const filtered = (data[pages[page]] || []).filter((r) =>
    JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
  );
  const taskState = (state: string) =>
    (data.tasks || []).filter((t) => t.state === state).length;
  async function inspect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const values = Object.fromEntries(new FormData(e.currentTarget));
      setImportPlan(
        await api("imports/inspect", {
          method: "POST",
          body: JSON.stringify(values),
        }),
      );
      setPreview(null);
      setImportResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function review(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const f = Object.fromEntries(new FormData(e.currentTarget)),
        mapping: Row = { repositories: {} };
      if (importPlan?.workspace)
        for (const r of importPlan.repositories)
          mapping.repositories[r.key] = f[r.key];
      else mapping.default_repo = f.default_repo;
      setPreview(
        await api("imports/" + importPlan!.id + "/review", {
          method: "POST",
          body: JSON.stringify(mapping),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function applyImport() {
    setBusy(true);
    try {
      setImportResult(
        await api("imports/" + importPlan!.id + "/apply", {
          method: "POST",
          body: JSON.stringify({
            confirm: true,
            review_version: preview!.review_version,
          }),
        }),
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!csrf)
    return (
      <main className="auth">
        <div className="brand">◈ Coordination</div>
        <h1>{setup ? "Your control plane starts here." : "Welcome back."}</h1>
        <p>One place for your repositories, agents, and shared work.</p>
        <form onSubmit={signin}>
          {setup && (
            <label>
              One-time bootstrap secret
              <input
                name="secret"
                type="password"
                required
                autoComplete="off"
              />
            </label>
          )}
          <label>
            Username
            <input name="username" required autoComplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={setup ? 12 : 1}
              required
              autoComplete={setup ? "new-password" : "current-password"}
            />
          </label>
          <button disabled={busy}>
            {busy ? "Connecting…" : setup ? "Create owner account" : "Sign in"}
          </button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  function card(r: Row) {
    return (
      <section key={r.id} className="resource-card">
        <span className="badge">
          {human(
            r.state ||
              r.status ||
              (r.revoked ? "revoked" : r.runtime) ||
              r.type ||
              "active",
          )}
        </span>
        <h2>{r.name || r.title || r.key || r.path || r.scope || r.id}</h2>
        {r.repo_id && <small>{repoName(r.repo_id)}</small>}
        <p>
          {r.description ||
            r.reason ||
            r.reference ||
            r.content ||
            "No description"}
        </p>
        {r.due_at && <p>Due {date(r.due_at)}</p>}
        {r.claimed_by && <p>Claimed by {label("agents", r.claimed_by)}</p>}
        {r.progress !== undefined && (
          <label>
            Progress {r.progress}%<progress max="100" value={r.progress} />
          </label>
        )}
        {r.heartbeat && (
          <p>
            {Date.now() - Date.parse(r.heartbeat) < 900000
              ? "Recently connected"
              : "Stale / disconnected"}{" "}
            · {date(r.heartbeat)}
          </p>
        )}
        {r.expires_at && <p>Expires {date(r.expires_at)}</p>}
        <small>
          Version {r.context_version || r.version} · {date(r.updated_at)}
        </small>
        <button className="quiet" onClick={() => viewRecord(pages[page], r)}>
          View details
        </button>
      </section>
    );
  }
  return (
    <div className="shell">
      <aside>
        <div className="brand">◈ Coordination</div>
        <small>OPERATOR WORKSPACE</small>
        <nav>
          {Object.keys(pages).map((n) => (
            <button
              key={n}
              className={page === n ? "selected" : ""}
              onClick={() => {
                setPage(n);
                setSearch("");
              }}
            >
              {n}
            </button>
          ))}
        </nav>
        <div className="aside-foot">
          Local control plane
          <br />
          <span>External agents · advisory leases</span>
          <button
            onClick={async () => {
              try {
                await api("auth/session", { method: "DELETE" });
                setCsrf("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>WORKSPACE / {page.toUpperCase()}</span>
          <div className="connection">
            ● {online ? (live ? "Live" : "Reconnecting") : "Offline"} ·{" "}
            {stamp || "Loading"}
          </div>
        </header>
        <div className="title">
          <div>
            <h1>{page === "Overview" ? "Keep work moving." : page}</h1>
            <p>
              {page === "Overview"
                ? "A clear view of every repo, agent, and handoff."
                : "Durable records from your coordination service."}
            </p>
          </div>
          {createAction[page] && (
            <button onClick={() => openAction(createAction[page])}>
              + Create
            </button>
          )}
        </div>
        {!online && (
          <div className="error">
            Offline. Changes cannot be saved until the connection returns.
          </div>
        )}
        {!live && online && stamp && (
          <p role="status">
            Live updates are reconnecting. Last successful refresh: {stamp}.
          </p>
        )}
        {(error || refreshError) && (
          <div role="alert" className="error">
            {error || refreshError}
            <button
              onClick={() => {
                setError("");
                setRefreshError("");
                refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}
        {loading && !stamp && <p role="status">Loading workspace…</p>}
        {page === "Overview" ? (
          <>
            <div className="stats">
              {[
                ["Repositories", data.repositories?.length || 0],
                [
                  "Recently seen",
                  data.agents?.filter(
                    (a) =>
                      !a.revoked &&
                      a.heartbeat &&
                      Date.now() - Date.parse(a.heartbeat) < 900000,
                  ).length || 0,
                ],
                ["In progress", taskState("in_progress")],
                ["Needs attention", taskState("blocked") + taskState("review")],
              ].map(([k, v]) => (
                <section key={k}>
                  <small>{k}</small>
                  <strong>{v}</strong>
                </section>
              ))}
            </div>
            <div className="columns">
              <section>
                <h2>Active work</h2>
                {(data.tasks || [])
                  .filter((t) => !["done", "cancelled"].includes(t.state))
                  .map((t) => (
                    <article key={t.id}>
                      <span className="badge">{human(t.state)}</span>
                      <h3>{t.title}</h3>
                      <p>{t.description}</p>
                      <button
                        className="quiet"
                        onClick={() => viewRecord("tasks", t)}
                      >
                        View task
                      </button>
                    </article>
                  ))}
                {!data.tasks?.length && (
                  <p>
                    Create a project, add its repositories, then assign your
                    first task.
                  </p>
                )}
              </section>
              <section>
                <h2>Recent activity</h2>
                {audit
                  .slice(-8)
                  .reverse()
                  .map((a) => (
                    <article key={a.id}>
                      <h3>{human(a.action)}</h3>
                      <small>{date(a.timestamp)}</small>
                    </article>
                  ))}
              </section>
            </div>
          </>
        ) : page === "Settings" ? (
          <>
            <section>
              <h2>Service & runtime</h2>
              <h3>Agent connection</h3>
              <p>
                MCP endpoint: <code>{window.location.origin}/mcp</code>
              </p>
              <p>
                Use an individually enrolled bearer token. Tokens are shown once
                and should be stored outside repository files. Non-local
                connections require a TLS reverse proxy.
              </p>
              <p>PostgreSQL · {settings.database ? "Connected" : "Checking"}</p>
              <p>{settings.runtime?.reason}</p>
              <p>
                Public endpoint: disabled by default. Worktree management:
                unsupported.
              </p>
              <h3>Active owner sessions</h3>
              {sessions.map((s) => (
                <article key={s.id}>
                  <p>
                    {s.current ? "This session" : "Another session"} · Last used{" "}
                    {date(s.last_used_at)} · Expires {date(s.expires_at)}
                  </p>
                  <button
                    className="quiet"
                    onClick={async () => {
                      try {
                        await api("auth/sessions/" + s.id, {
                          method: "DELETE",
                        });
                        if (s.current) setCsrf("");
                        else await refresh();
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Revoke session
                  </button>
                </article>
              ))}
              <p>Events awaiting live dispatch: {settings.outbox_pending}</p>
              <p>
                Consistent SQLite backups: {ops.backup_count || 0}. Database
                backups use the documented pg_dump/restore commands.
              </p>
            </section>
            <section className="settings-section">
              <h2>Legacy import</h2>
              <p>
                Inspect a read-only source, review its destination mapping, then
                explicitly confirm the import. Original databases remain
                unchanged; legacy identities stay untrusted and leases become
                expired.
              </p>
              {!ops.import_available ? (
                <p>
                  Configure LEGACY_IMPORT_ROOT and a backup directory to enable
                  import. No server files are exposed by default.
                </p>
              ) : (
                <>
                  <button
                    onClick={async () => {
                      try {
                        setSources((await api("imports/discover")).items);
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Discover databases
                  </button>
                  <form onSubmit={inspect}>
                    <label>
                      Source database
                      <select
                        aria-label="Source database"
                        name="source"
                        required
                      >
                        <option value="">Choose a discovered database…</option>
                        {sources.map((s) => (
                          <option key={s.path} value={s.path}>
                            {s.path} · schema {s.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Stable source label
                      <input
                        name="source_id"
                        required
                        placeholder="backend-legacy"
                      />
                    </label>
                    <button disabled={busy}>Create backup & inspect</button>
                  </form>
                </>
              )}
              {importPlan && (
                <div className="import-review">
                  <h3>Backup created · {importPlan.source_id}</h3>
                  <pre>{JSON.stringify(importPlan.counts, null, 2)}</pre>
                  <form onSubmit={review}>
                    {(importPlan.workspace
                      ? importPlan.repositories
                      : [{ key: "default_repo" }]
                    ).map((r: Row) => (
                      <label key={r.key}>
                        Destination for {r.key}
                        <select
                          aria-label={"Destination for " + r.key}
                          name={r.key}
                          required
                        >
                          <option value="">Choose repo…</option>
                          {data.repositories?.map((repo) => (
                            <option key={repo.id} value={repo.id}>
                              {repo.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <button disabled={busy}>Review mapping</button>
                  </form>
                  {preview && (
                    <>
                      <h3>Review: {preview.proposed.length} mapped records</h3>
                      {preview.warnings.map((w: string) => (
                        <p key={w}>{w}</p>
                      ))}
                      {preview.issues.length ? (
                        <pre role="alert">
                          {JSON.stringify(preview.issues, null, 2)}
                        </pre>
                      ) : (
                        <button
                          disabled={busy || !!importResult}
                          onClick={applyImport}
                        >
                          Confirm import into selected repositories
                        </button>
                      )}
                      <details>
                        <summary>Proposed record mappings</summary>
                        <pre>{JSON.stringify(preview.proposed, null, 2)}</pre>
                      </details>
                    </>
                  )}
                  {importResult && (
                    <p role="status">
                      Import recorded: {importResult.id}.{" "}
                      {importResult.already_imported
                        ? "This exact source and mapping were already imported."
                        : "Records were committed successfully."}
                    </p>
                  )}
                </div>
              )}
            </section>
          </>
        ) : page === "Activity" ? (
          <section>
            <div className="toolbar">
              <input
                placeholder="Search activity"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(audit, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "coordination-audit.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export events
              </button>
            </div>
            <details className="settings-section">
              <summary>Imported historical records</summary>
              <p>
                These records retain legacy history. They do not grant active
                access or represent current authenticated decisions.
              </p>
              <div className="toolbar">
                <select
                  aria-label="Historical record type"
                  value={historyKind}
                  disabled={busy}
                  onChange={(e) => {
                    setHistoryKind(e.target.value);
                    setHistoryPage(null);
                  }}
                >
                  {[
                    "messages",
                    "legacy_approvals",
                    "legacy_audit",
                    "handoffs",
                  ].map((kind) => (
                    <option key={kind} value={kind}>
                      {human(kind)}
                    </option>
                  ))}
                </select>
                <button disabled={busy} onClick={() => loadHistory()}>
                  Load historical records
                </button>
              </div>
              {historyPage?.items.map((record: Row) => (
                <article key={record.id}>
                  <b>{human(record.legacy_type || "historical record")}</b>
                  <p>
                    {repoName(record.repo_id)} · {date(record.created_at)}
                  </p>
                  <button
                    className="quiet"
                    onClick={() => viewRecord(historyKind, record)}
                  >
                    Inspect historical record
                  </button>
                </article>
              ))}
              {historyPage && !historyPage.items.length && (
                <p>No historical records in this page.</p>
              )}
              {historyPage?.has_more && (
                <button
                  disabled={busy}
                  onClick={() => loadHistory(historyPage.next_cursor)}
                >
                  Next historical page
                </button>
              )}
            </details>
            {audit
              .filter((a) =>
                JSON.stringify(a).toLowerCase().includes(search.toLowerCase()),
              )
              .reverse()
              .map((a) => (
                <article key={a.id}>
                  <b>{human(a.action)}</b>
                  {!a.read_at && (
                    <button
                      className="quiet"
                      onClick={async () => {
                        try {
                          await api("notifications/" + a.id + "/read", {
                            method: "POST",
                            body: "{}",
                          });
                          await refresh();
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                    >
                      Mark read
                    </button>
                  )}
                  <p>
                    Actor {label("agents", a.actor)} · {date(a.timestamp)}
                  </p>
                  <small>
                    {a.resource_id} · Request{" "}
                    {a.request_id || "local operation"}
                  </small>
                  <details>
                    <summary>Event details</summary>
                    <pre>{JSON.stringify(a.metadata, null, 2)}</pre>
                  </details>
                </article>
              ))}
          </section>
        ) : (
          <>
            <div className="toolbar">
              <input
                placeholder={"Search " + page.toLowerCase()}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {page === "Tasks" && (
                <button className="quiet" onClick={() => setBoard(!board)}>
                  {board ? "List view" : "Board view"}
                </button>
              )}
              <select
                aria-label="More actions"
                value=""
                onChange={(e) => openAction(e.target.value)}
              >
                <option value="">More actions…</option>
                {Object.keys(operations).map((a) => (
                  <option key={a} value={a}>
                    {human(a)}
                  </option>
                ))}
              </select>
            </div>
            {page === "Reservations" && (
              <p>
                Reservations are advisory. External IDE writes are not blocked.
                No managed worktree adapter is installed.
              </p>
            )}
            {board && page === "Tasks" ? (
              <div className="board">
                {[
                  "ready",
                  "in_progress",
                  "blocked",
                  "review",
                  "done",
                  "cancelled",
                ].map((state) => (
                  <div key={state}>
                    <h2>{human(state)}</h2>
                    {filtered.filter((t) => t.state === state).map(card)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="cards">{filtered.map(card)}</div>
            )}
            {!filtered.length && (
              <section className="empty">
                <h2>
                  No {page.toLowerCase()}{" "}
                  {search ? "matching your search" : "yet"}
                </h2>
                <p>
                  {search
                    ? "Try a different search."
                    : "Create a record to get started."}
                </p>
              </section>
            )}
          </>
        )}
        {selected && (
          <div className="overlay">
            <section className="dialog detail">
              <button
                className="close"
                aria-label="Close details"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
              <span className="badge">
                {human(selected.state || selected.status || "Details")}
              </span>
              <h2>
                {selected.title ||
                  selected.name ||
                  selected.key ||
                  selected.scope ||
                  selected.path ||
                  selected.legacy_type ||
                  selected.id}
              </h2>
              <p>
                {selected.description || selected.reason || selected.content}
              </p>
              {selected.legacy_record && (
                <>
                  <p>
                    Historical source record — no active permission is implied.
                  </p>
                  <pre>{JSON.stringify(selected.legacy_record, null, 2)}</pre>
                </>
              )}
              <p>
                Repository: {repoName(selected.repo_id) || "—"} · Version{" "}
                {selected.version}
              </p>
              <div className="detail-actions">
                {["projects", "repositories"].includes(selected.resource) && (
                  <button
                    onClick={() =>
                      openAction(
                        selected.resource === "projects"
                          ? "project_edit"
                          : "repo_edit",
                        {
                          ...selected,
                          kind: selected.resource,
                          id: selected.id,
                          version: selected.version,
                          name: selected.name,
                          status: selected.status,
                        },
                      )
                    }
                  >
                    Edit / archive
                  </button>
                )}
                {selected.resource === "agents" && (
                  <>
                    {selected.untrusted && (
                      <button
                        onClick={() =>
                          openAction("agent_enroll", {
                            name: selected.name,
                            existing_id: selected.id,
                          })
                        }
                      >
                        Enroll imported agent
                      </button>
                    )}
                    <button
                      onClick={() =>
                        openAction("agent_rotate", { id: selected.id })
                      }
                    >
                      Rotate token
                    </button>
                    <button
                      onClick={() =>
                        openAction("agent_revoke", { id: selected.id })
                      }
                    >
                      Revoke agent
                    </button>
                    <button
                      onClick={() =>
                        openAction("grant_set", { agent_id: selected.id })
                      }
                    >
                      Manage grants
                    </button>
                  </>
                )}
                {selected.resource === "tasks" && (
                  <>
                    <button
                      onClick={() =>
                        openAction("task_update", {
                          ...selected,
                          id: selected.id,
                          version: selected.version,
                          state: selected.state,
                          progress: selected.progress,
                        })
                      }
                    >
                      Update task
                    </button>
                    <button
                      onClick={() =>
                        openAction("task_comment", { id: selected.id })
                      }
                    >
                      Add comment
                    </button>
                    <button
                      onClick={() =>
                        openAction("task_handoff", {
                          id: selected.id,
                          version: selected.version,
                        })
                      }
                    >
                      Hand off
                    </button>
                    <button
                      onClick={() =>
                        openAction("dependency_add", { id: selected.id })
                      }
                    >
                      Add dependency
                    </button>
                    <button
                      onClick={() =>
                        openAction("request_create", {
                          repo_id: selected.repo_id,
                          task_id: selected.id,
                        })
                      }
                    >
                      Request cross-repo help
                    </button>
                  </>
                )}
                {selected.resource === "cross_repo_requests" && (
                  <>
                    <button
                      onClick={() =>
                        openAction("request_clarify", { id: selected.id })
                      }
                    >
                      Clarify request
                    </button>
                    <button
                      onClick={() =>
                        openAction("request_decide", { id: selected.id })
                      }
                    >
                      Approve / deny
                    </button>
                    <button
                      onClick={() =>
                        openAction("request_answer", { id: selected.id })
                      }
                    >
                      Answer approved request
                    </button>
                  </>
                )}
                {selected.resource === "file_reservations" && (
                  <button
                    onClick={() =>
                      openAction("reservation_release", { id: selected.id })
                    }
                  >
                    Release lease
                  </button>
                )}
              </div>
              {selected.resource === "agents" && (
                <>
                  <h3>Repository grants</h3>
                  {data.agent_repo_grants
                    ?.filter((g) => g.agent_id === selected.id)
                    .map((g) => (
                      <article key={g.id}>
                        <b>{repoName(g.repo_id)}</b>
                        <p>{g.permissions.join(", ") || "No permissions"}</p>
                        {g.expires_at && (
                          <small>
                            {Date.parse(g.expires_at) <= Date.now()
                              ? "Expired"
                              : "Expires"}{" "}
                            {date(g.expires_at)}
                          </small>
                        )}
                      </article>
                    ))}
                  <h3>Tokens</h3>
                  {data.agent_tokens
                    ?.filter((t) => t.agent_id === selected.id)
                    .map((t) => (
                      <article key={t.id}>
                        <p>
                          Prefix {t.prefix}… ·{" "}
                          {t.revoked
                            ? "Revoked"
                            : `Expires ${date(t.expires_at)}`}
                        </p>
                        <button
                          className="quiet"
                          onClick={() =>
                            openAction("token_revoke", { id: t.id })
                          }
                        >
                          Revoke token
                        </button>
                      </article>
                    ))}
                </>
              )}
              {selected.resource === "tasks" && (
                <>
                  <h3>Dependencies</h3>
                  {data.task_dependencies
                    ?.filter((d) => d.task_id === selected.id)
                    .map((d) => (
                      <article key={d.id}>
                        {label("tasks", d.depends_on)}{" "}
                        <button
                          className="quiet"
                          onClick={() =>
                            openAction("dependency_remove", { id: d.id })
                          }
                        >
                          Remove dependency
                        </button>
                      </article>
                    ))}
                  <h3>History & comments</h3>
                  {data.task_events
                    ?.filter((e) => e.task_id === selected.id)
                    .map((e) => (
                      <article key={e.id}>
                        <b>{human(e.action || e.legacy_type || "event")}</b>
                        <p>{e.comment || e.state}</p>
                        <small>{date(e.created_at)}</small>
                      </article>
                    ))}
                  <h3>Linked requests</h3>
                  {data.cross_repo_requests
                    ?.filter((q) => q.task_id === selected.id)
                    .map((q) => (
                      <article key={q.id}>
                        {q.scope} · {q.state}
                      </article>
                    ))}
                </>
              )}
              {selected.resource === "cross_repo_requests" && (
                <>
                  <h3>Scope and decision</h3>
                  <p>
                    {repoName(selected.repo_id)} →{" "}
                    {repoName(selected.target_repo)}
                  </p>
                  <p>{selected.scope}</p>
                  <p>
                    Response format: {selected.format} · Expires{" "}
                    {date(selected.expires_at)}
                  </p>
                  <p>{selected.decision_reason}</p>
                  <h3>Decision history</h3>
                  {selected.history?.map((event: Row, i: number) => (
                    <article key={i}>
                      <b>{human(event.state)}</b>
                      <p>{event.reason}</p>
                      <small>
                        {label("agents", event.actor)} · {date(event.timestamp)}
                      </small>
                    </article>
                  ))}
                  <h3>Responses</h3>
                  {data.cross_repo_responses
                    ?.filter((r) => r.request_id === selected.id)
                    .map((r) => (
                      <article key={r.id}>
                        <pre>{r.content}</pre>
                        {r.reference && (
                          <p>
                            {r.reference.path} @ {r.reference.commit}
                          </p>
                        )}
                        <small>
                          Responder {label("agents", r.responder)} ·{" "}
                          {date(r.created_at)}
                        </small>
                      </article>
                    ))}
                </>
              )}
              <details>
                <summary>Record metadata</summary>
                <pre>{JSON.stringify(selected, null, 2)}</pre>
              </details>
            </section>
          </div>
        )}
        {action && (
          <div className="overlay">
            <section className="dialog">
              <button
                className="close"
                aria-label="Close form"
                onClick={() => setAction("")}
              >
                ×
              </button>
              <h2>{human(action)}</h2>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <form onSubmit={submit}>
                {Object.entries(operations[action]).map(([k, t]) => (
                  <label key={k}>
                    {human(k)}
                    {t === "textarea" ? (
                      <textarea
                        aria-label={human(k)}
                        name={k}
                        required
                        defaultValue={defaults[k]}
                      />
                    ) : t === "permissions" ? (
                      <div className="checks">
                        {permissions.map((p) => (
                          <label key={p}>
                            <input
                              aria-label={p}
                              name={k}
                              type="checkbox"
                              value={p}
                              defaultChecked={
                                defaults.permissions?.includes(p) || false
                              }
                            />
                            {p}
                          </label>
                        ))}
                      </div>
                    ) : t === "repo_ids" ? (
                      <select aria-label={human(k)} name={k} multiple>
                        {(data.repositories || []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    ) : t === "boolean" ? (
                      <select
                        aria-label={human(k)}
                        name={k}
                        defaultValue={String(defaults[k] ?? true)}
                      >
                        <option value="true">Case sensitive</option>
                        <option value="false">Case insensitive</option>
                      </select>
                    ) : choices[t] ? (
                      <select
                        aria-label={human(k)}
                        name={k}
                        defaultValue={defaults[k]}
                      >
                        {choices[t].map((v) => (
                          <option key={v} value={v}>
                            {human(v)}
                          </option>
                        ))}
                      </select>
                    ) : data[t.replace("?", "")] ? (
                      <select
                        aria-label={human(k)}
                        name={k}
                        required={!t.endsWith("?")}
                        defaultValue={defaults[k] || ""}
                      >
                        <option value="">Choose…</option>
                        {data[t.replace("?", "")].map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name || r.title || r.scope || r.prefix || r.id}{" "}
                            {r.version ? `(v${r.version})` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={human(k)}
                        name={k}
                        type={
                          t.replace("?", "") === "number"
                            ? "number"
                            : t.replace("?", "") === "datetime"
                              ? "datetime-local"
                              : "text"
                        }
                        required={!t.endsWith("?")}
                        defaultValue={
                          defaults[k] ??
                          (k === "version" || k === "priority"
                            ? "1"
                            : k === "progress"
                              ? "0"
                              : k === "default_branch"
                                ? "main"
                                : k === "format"
                                  ? "structured JSON"
                                  : undefined)
                        }
                      />
                    )}
                  </label>
                ))}
                <button disabled={busy || !online}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </form>
            </section>
          </div>
        )}
        {credential && (
          <div className="overlay">
            <section className="dialog">
              <h2>Save this agent token</h2>
              <p>
                Shown once. Store it outside your repository. It will not be
                recoverable.
              </p>
              <code className="secret">{credential}</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(credential);
                  } catch {
                    setError(
                      "Clipboard unavailable. Select and copy the token manually.",
                    );
                  }
                }}
              >
                Copy
              </button>
              <button onClick={() => setCredential("")}>I saved it</button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
