// Builds the desktop client into dist/: the main process (with the connector from src/connect and ws inside), the two
// preloads, and the static first-run page with Jarvy's icons. The client has Jarvy's version (../package.json): one
// number for both, released together.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/static", { recursive: true });
const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "bufferutil", "utf-8-validate"], logLevel: "warning",
  // The connector in ../src/connect takes its packages (ws) from here, not from the server's node_modules.
  nodePaths: [fileURLToPath(new URL("node_modules", import.meta.url))] };
export const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js", define: { JARVY_VERSION: JSON.stringify(version) } });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
await build({ ...common, entryPoints: ["src/setup-preload.ts"], outfile: "dist/setup-preload.js" });
cpSync("static", "dist/static", { recursive: true });
cpSync("../src/web/public/icon-512.png", "dist/static/icon.png");
