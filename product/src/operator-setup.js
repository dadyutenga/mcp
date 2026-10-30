import { writeFile, readFile, mkdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { privateFile, endpoint } from "./credentials.js";
import { installAgent } from "./setup.js";
import { permissions } from "./service.js";
const schema = z
  .object({
    url: z.string().default("http://127.0.0.1:4310/mcp"),
    username: z.string().min(3),
    password: z.string().min(12),
    bootstrap_secret: z.string().optional(),
    project: z.string().min(1),
    repo: z.string().min(1),
    reference: z.string().min(1),
    agent: z.string().min(1),
    repo_path: z.string(),
    token_file: z.string(),
    permissions: z
      .array(z.enum(permissions))
      .min(1)
      .default(permissions.filter((p) => p !== "cross_repo:approve")),
  })
  .strict();
export async function provision(input) {
  const config = schema.parse(input),
    mcp = endpoint(config.url),
    base = new URL("/api/v1/", mcp),
    root = await realpath(config.repo_path),
    tokenPath = path.resolve(config.token_file),
    relative = path.relative(root, tokenPath);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw Error("Keep agent credentials outside the repository");
  // Resolve the credential directory before writing so symlinked parents cannot
  // accidentally place a token inside a working repository.
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const resolvedParent = await realpath(path.dirname(tokenPath));
  const actual = path.join(resolvedParent, path.basename(tokenPath));
  const actualRelative = path.relative(root, actual);
  if (
    !actualRelative ||
    (!actualRelative.startsWith(".." + path.sep) &&
      actualRelative !== ".." &&
      !path.isAbsolute(actualRelative))
  )
    throw Error("Keep agent credentials outside the repository");
  let cookie = "",
    csrf = "";
  async function api(route, body) {
    const r = await fetch(new URL(route, base), {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await r.json();
    if (!r.ok)
      throw Error(value.error?.message || "Operator setup request failed");
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    return value;
  }
  if ((await api("auth/setup")).bootstrap_required) {
    if (!config.bootstrap_secret)
      throw Error(
        "First setup requires bootstrap_secret matching the service BOOTSTRAP_SECRET",
      );
    await api("auth/bootstrap", {
      secret: config.bootstrap_secret,
      username: config.username,
      password: config.password,
    });
  }
  csrf = (
    await api("auth/session", {
      username: config.username,
      password: config.password,
    })
  ).csrf;
  async function find(kind, test) {
    const rows = [];
    let after = "";
    do {
      const page = await api("resources/" + kind + "?after=" + after);
      rows.push(...page.items.filter(test));
      if (!page.has_more) break;
      after = page.next_cursor;
    } while (true);
    if (rows.length > 1)
      throw Error(
        "Ambiguous existing " + kind + "; use unique names/references",
      );
    return rows[0];
  }
  try {
    const project =
      (await find("projects", (r) => r.name === config.project)) ||
      (await api("actions/project_create", { name: config.project }));
    if (project.status === "archived") throw Error("Project is archived");
    const repo =
      (await find(
        "repositories",
        (r) =>
          r.project_id === project.id &&
          r.name === config.repo &&
          r.reference === config.reference,
      )) ||
      (await api("actions/repo_create", {
        project_id: project.id,
        name: config.repo,
        reference: config.reference,
      }));
    if (repo.status === "archived") throw Error("Repository is archived");
    const exists = await lstat(tokenPath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!exists) {
      const agent = await api("actions/agent_enroll", {
        name: config.agent,
        grants: [{ repo_id: repo.id, permissions: config.permissions }],
      });
      await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(tokenPath, agent.token + "\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        await api("actions/agent_revoke", { id: agent.agent.id }).catch(
          () => {},
        );
        throw error;
      }
    }
    const setup = await installAgent({
      repo: root,
      url: mcp.href,
      tokenFile: tokenPath,
      repoId: repo.id,
    });
    if (
      JSON.stringify([...setup.permissions].sort()) !==
      JSON.stringify([...config.permissions].sort())
    ) {
      await api("actions/grant_set", {
        agent_id: setup.agent_id,
        repo_id: repo.id,
        permissions: config.permissions,
        reason: "Explicit operator setup configuration",
      });
      setup.permissions = config.permissions;
    }
    return setup;
  } finally {
    await fetch(new URL("auth/session", base), {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    }).catch(() => {});
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({ options: { config: { type: "string" } } });
    if (!values.config)
      throw Error("Use --config /absolute/private/operator.json");
    console.log(
      JSON.stringify(
        await provision(JSON.parse(await privateFile(values.config))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
