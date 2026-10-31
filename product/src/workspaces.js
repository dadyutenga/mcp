import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const exec = promisify(execFile);

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
  const client = new Client({ name, version: "1" });
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
      this.active = this.sessions.size === 1 ? registration.repo_id : null;
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
      this.active =
        this.sessions.size === 1 ? this.sessions.keys().next().value : null;
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
      active_repo_id: this.active,
      workspaces: [...this.sessions.values()].map((s) => this.summary(s)),
    };
  }
  select(id) {
    if (!this.sessions.has(id))
      throw Error("Register this repository in the current workspace first");
    this.active = id;
    return this.summary(this.sessions.get(id));
  }
  client(args = {}) {
    const id = args.repo_id || args.input?.repo_id || this.active;
    if (!id || !this.sessions.has(id))
      throw Error(
        "Use workspace_register with your repository path, then workspace_select for a multi-repository workspace",
      );
    return this.sessions.get(id).client;
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
