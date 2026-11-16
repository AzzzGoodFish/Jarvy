// Builds the desktop client into dist/: the main process (with the connector from src/connect and ws inside), the two
// preloads, and the static first-run page with Jarvy's icons.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/static", { recursive: true });
const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "bufferutil", "utf-8-validate"], logLevel: "warning" };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
await build({ ...common, entryPoints: ["src/setup-preload.ts"], outfile: "dist/setup-preload.js" });
cpSync("static", "dist/static", { recursive: true });
cpSync("../src/web/public/icon-512.png", "dist/static/icon.png");
