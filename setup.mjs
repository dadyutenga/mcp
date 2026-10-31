import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const help = `Coordination MCP setup

  node setup.mjs
  node setup.mjs --client cursor --project my-workspace
  node setup.mjs --url https://coordination.example/mcp
  node setup.mjs --config /absolute/private/global-setup.json

Requires Node.js 24+, Git, and Docker with Compose for a new local service.
An existing service needs no Docker on this computer.
Setup installs dependencies, prepares the service and installs global editor config.
`;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
} else {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw Error(
        "Install Node.js 24 or newer, then run node setup.mjs again.",
      );
    const product = fileURLToPath(new URL("./product/", import.meta.url));
    const installed = await access(
      new URL(
        "./product/node_modules/@modelcontextprotocol/sdk/package.json",
        import.meta.url,
      ),
    ).then(
      () => true,
      () => false,
    );
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
