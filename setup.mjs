import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
const { version } = JSON.parse(
  await readFile(new URL("./product/package.json", import.meta.url), "utf8"),
);

const help = `Coordination MCP v${version} setup

  node setup.mjs
  node setup.mjs --client cursor --project my-workspace
  node setup.mjs --client codex,claude,grok
  node setup.mjs --client all
  node setup.mjs --url https://coordination.example/mcp
  node setup.mjs --config /absolute/private/global-setup.json

Requires Node.js 24+, Git, and Docker with Compose for a new local service.
An existing service needs no Docker on this computer.
Setup installs dependencies, prepares the service and installs global editor config.
`;
if (process.argv.includes("--version")) {
  console.log(version);
} else if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
} else {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw Error(
        "Install Node.js 24 or newer, then run node setup.mjs again.",
      );
    const product = fileURLToPath(new URL("./product/", import.meta.url));
    const installed = await Promise.all(
      ["@modelcontextprotocol/sdk", "smol-toml"].map((name) =>
        access(
          new URL(
            `./product/node_modules/${name}/package.json`,
            import.meta.url,
          ),
        ).then(
          () => true,
          () => false,
        ),
      ),
    ).then((results) => results.every(Boolean));
    if (!installed) {
      console.log("Installing coordination dependencies...");
      const code = await new Promise((resolve, reject) => {
        // npm.cmd needs cmd.exe on Windows; arguments here are fixed, not user text.
        const child =
          process.platform === "win32"
            ? spawn(
                process.env.ComSpec || "cmd.exe",
                ["/d", "/s", "/c", "npm ci"],
                { cwd: product, stdio: "inherit", windowsHide: true },
              )
            : spawn("npm", ["ci"], { cwd: product, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code !== 0)
        throw Error(
          "Dependency installation failed. Fix the npm error and run setup again.",
        );
    }
    const { main } = await import("./product/src/first-run.js");
    await main(process.argv.slice(2));
  } catch (error) {
    console.error("Setup: " + error.message);
    process.exitCode = 1;
  }
}
