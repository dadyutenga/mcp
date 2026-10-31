import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "./version.js";
const exec = promisify(execFile);
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: { result: value },
});
const failure = (message) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});
const lists = new Set([
  "agent_list",
  "collaboration_list",
  "collaboration_inbox",
  "tasks_list",
  "repositories_list",
  "projects_list",
  "task_events_list",
  "file_reservations_list",
  "cross_repo_requests_list",
  "cross_repo_responses_list",
  "shared_context_items_list",
]);
function resourceKind(name) {
  if (name === "task_events_list") return null;
  if (name.startsWith("task_") || name.startsWith("tasks_")) return "tasks";
  if (name.startsWith("reservation_") || name.startsWith("file_reservations_"))
    return "file_reservations";
  if (
    name.startsWith("request_") ||
    name.startsWith("cross_repo_requests_") ||
    name === "collaboration_inbox"
  )
    return "cross_repo_requests";
  if (name.startsWith("cross_repo_responses_")) return "cross_repo_responses";
  if (name.startsWith("shared_context_items_")) return "shared_context_items";
  return null;
}

export async function gitWorkspace(input) {
  const directory = input.startsWith("file:") ? fileURLToPath(input) : input;
  if (!path.isAbsolute(directory))
    throw Error("Use an absolute repository path or file URI");
  const resolved = await realpath(directory);
  let result;
  try {
    result = await exec(
      "git",
      ["-C", resolved, "rev-parse", "--show-toplevel"],
      { timeout: 5000 },
    );
  } catch {
    throw Error("Workspace must be inside an existing Git repository");
  }
  const root = await realpath(result.stdout.trim());
  let branch = "main";
  try {
    const result = await exec(
      "git",
      ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { timeout: 5000 },
    );
    branch = result.stdout.trim().replace(/^origin\//, "");
  } catch {
    /* Repositories without an origin HEAD retain the conventional default. */
  }
  return {
    name: path.basename(root),
    reference: root,
    default_branch: branch,
    case_sensitive: process.platform !== "win32",
  };
}

export async function connectAgent(url, token, name) {
  const client = new Client({ name, version: VERSION });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export class Workspaces {
  constructor(enrollment, url, clientName) {
    this.enrollment = enrollment;
    this.url = url;
    this.clientName = clientName;
    this.sessions = new Map();
    this.active = null;
    this.pending = Promise.resolve();
    this.resources = new Map();
  }
  register(input) {
    const result = this.pending.then(async () => {
      const workspace = await gitWorkspace(input);
      const existing = [...this.sessions.values()].find(
        (s) => s.repository.reference === workspace.reference,
      );
      if (existing) return this.summary(existing);
      const response = await this.enrollment.callTool({
        name: "workspace_register",
        arguments: { ...workspace, client: this.clientName },
      });
      if (response.isError)
        throw Error(
          response.content?.find((c) => c.type === "text")?.text ||
            "Workspace registration failed",
        );
      const { token, ...registration } = response.structuredContent.result;
      const client = await connectAgent(this.url, token, this.clientName);
      try {
        const setup = await client.callTool({
          name: "agent_setup",
          arguments: { repo_id: registration.repo_id },
        });
        if (setup.isError) throw Error("Workspace authorization failed");
      } catch (error) {
        await client.close();
        throw error;
      }
      this.sessions.set(registration.repo_id, { ...registration, client });
      if (!this.active) this.active = registration.repo_id;
      return registration;
    });
    this.pending = result.catch(() => {});
    return result;
  }
  async refresh(inputs) {
    const retained = new Set(),
      errors = [];
    for (const input of inputs) {
      try {
        retained.add((await this.register(input)).repo_id);
      } catch (error) {
        errors.push({ root: input, error: error.message });
      }
    }
    for (const [id, session] of this.sessions) {
      if (retained.has(id)) continue;
      this.sessions.delete(id);
      await session.client.close();
    }
    if (!this.sessions.has(this.active))
      this.active = this.sessions.keys().next().value || null;
    return errors;
  }
  summary(session) {
    return {
      agent_id: session.agent_id,
      repo_id: session.repo_id,
      project_id: session.project_id,
      repository: session.repository,
    };
  }
  status() {
    return {
      mode: "all_registered",
      active_repo_ids: [...this.sessions.keys()],
      default_repo_id: this.active,
      workspaces: [...this.sessions.values()].map((s) => this.summary(s)),
    };
  }
  select(id) {
    if (!this.sessions.has(id))
      throw Error("Register this repository in the current workspace first");
    this.active = id;
    return { ...this.summary(this.sessions.get(id)), ...this.status() };
  }
  client(args = {}) {
    const id = args.repo_id || args.input?.repo_id || this.active;
    if (!id || !this.sessions.has(id))
      throw Error(
        "Register the repository with workspace_register, then provide its repo_id with the operation. All registered repositories stay active.",
      );
    return this.sessions.get(id).client;
  }
  remember(name, value) {
    const kind =
      name === "request_answer" ? "cross_repo_responses" : resourceKind(name);
    if (!kind || !value) return;
    for (const item of value.items || (value.id ? [value] : [])) {
      if (!item.id) continue;
      this.resources.set(`${kind}:${item.id}`, {
        id: item.id,
        repo_id: item.repo_id,
        target_repo: item.target_repo,
        requester: item.requester,
      });
      if (this.resources.size > 1000)
        this.resources.delete(this.resources.keys().next().value);
    }
  }
  async scoped(session, params) {
    const response = await session.client.callTool(params);
    if (!response.isError)
      this.remember(params.name, response.structuredContent?.result);
    return response;
  }
  async collect(params) {
    return Promise.all(
      [...this.sessions.values()].map(async (session) => {
        try {
          const response = await this.scoped(session, params);
          return {
            session,
            response,
            value: response.structuredContent?.result,
          };
        } catch {
          return {
            session,
            response: failure("Workspace connection unavailable"),
          };
        }
      }),
    );
  }
  async call(params) {
    if (!this.sessions.size)
      return failure(
        "Use workspace_register with your Git repository path. Registration activates it immediately.",
      );
    const args = params.arguments || {};
    const repo = args.repo_id || args.input?.repo_id;
    if (repo) {
      const session = this.sessions.get(repo);
      return session
        ? this.scoped(session, params)
        : failure(
            `Repository ${repo} is not registered in this connection. Use workspace_register with its path.`,
          );
    }
    if (this.sessions.size === 1)
      return this.scoped(this.sessions.values().next().value, params);
    if (
      lists.has(params.name) ||
      ["events_poll", "identity_get", "agent_setup", "state_snapshot"].includes(
        params.name,
      )
    ) {
      const pages = await this.collect(params),
        good = pages.filter((p) => !p.response.isError);
      const errors = pages
        .filter((p) => p.response.isError)
        .map((p) => ({
          repo_id: p.session.repo_id,
          error: p.response.content?.[0]?.text || "Workspace request failed",
        }));
      if (!good.length)
        return failure(JSON.stringify({ workspace_errors: errors }));
      if (params.name === "events_poll") {
        const events = [
          ...new Map(
            good.flatMap((p) => p.value || []).map((e) => [e.id, e]),
          ).values(),
        ]
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, 100);
        const response = result(events);
        if (errors.length) response.structuredContent.workspace_errors = errors;
        return response;
      }
      if (lists.has(params.name)) {
        const unique = new Map();
        for (const page of good)
          for (const item of page.value?.items || []) {
            const key = item.id || item.repo_id;
            if (!unique.has(key)) unique.set(key, { ...item });
          }
        const all = [...unique.values()].sort((a, b) =>
          String(a.id || a.repo_id).localeCompare(String(b.id || b.repo_id)),
        );
        const limit = Math.min(50, args.limit || 50),
          items = [];
        let bytes = 0;
        for (const item of all) {
          const size = JSON.stringify(item).length * 3;
          if (items.length >= limit || bytes + size > 28000) break;
          items.push(item);
          bytes += size;
        }
        return result({
          items,
          has_more:
            all.length > items.length || good.some((p) => p.value?.has_more),
          next_cursor:
            items.at(-1)?.id || items.at(-1)?.repo_id || args.after || "",
          active_repo_ids: [...this.sessions.keys()],
          ...(errors.length ? { workspace_errors: errors } : {}),
          ...(good[0].value?.presence_explanation
            ? { presence_explanation: good[0].value.presence_explanation }
            : {}),
        });
      }
      const key = params.name === "identity_get" ? "identities" : "workspaces";
      const entries = [];
      let bytes = 0;
      for (const page of good) {
        const entry = { ...page.value, repo_id: page.session.repo_id };
        const size = JSON.stringify(entry).length * 3;
        if (bytes + size > 28000)
          entries.push({
            repo_id: page.session.repo_id,
            agent_id: page.session.agent_id,
            details_omitted: true,
          });
        else {
          entries.push(entry);
          bytes += size;
        }
      }
      return result({
        mode: "all_registered",
        active_repo_ids: [...this.sessions.keys()],
        [key]: entries,
        ...(errors.length ? { workspace_errors: errors } : {}),
      });
    }
    const id = args.id || args.input?.id,
      kind = resourceKind(params.name);
    if (id && kind) {
      let resource = this.resources.get(`${kind}:${id}`);
      if (!resource) {
        const found = await this.collect({
          name: `${kind}_get`,
          arguments: { id },
        });
        resource = found.find((p) => !p.response.isError)?.value;
      }
      if (!resource)
        return failure(
          "Resource was not found in any authorized registered repository.",
        );
      let target = resource.repo_id;
      if (
        [
          "request_read",
          "request_work",
          "request_decide",
          "request_answer",
        ].includes(params.name)
      ) {
        const source = this.sessions.get(resource.repo_id);
        target =
          params.name === "request_decide" &&
          args.input?.decision === "revoked" &&
          source?.agent_id === resource.requester
            ? resource.repo_id
            : resource.target_repo;
      }
      const session = this.sessions.get(target);
      if (session) return this.scoped(session, params);
      if (params.name.endsWith("_get")) {
        const found = await this.collect(params);
        return (
          found.find((p) => !p.response.isError)?.response ||
          failure("Resource is unavailable")
        );
      }
      return failure(
        `The owning repository ${target} must be registered before this operation. All currently registered repositories remain active.`,
      );
    }
    return failure(
      `Include input.repo_id (or repo_id) for ${params.name}. All registered repositories are already active; workspace_select is not required.`,
    );
  }
  async heartbeat() {
    await Promise.allSettled(
      [...this.sessions.values()].map((s) =>
        s.client.callTool({
          name: "agent_setup",
          arguments: { repo_id: s.repo_id },
        }),
      ),
    );
  }
  async close() {
    await this.pending;
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.client.close()),
    );
    await this.enrollment.close();
  }
}
