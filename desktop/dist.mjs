// Packs the client with Jarvy's version (one number for both): builds, then runs electron-builder with that version
// written into the packed app's package.json. Extra arguments go to electron-builder (--win, --linux …).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const run = (command, args) => { const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" }); if (result.status !== 0) process.exit(result.status ?? 1); };
run("node", ["build.mjs"]);
run("npx", ["electron-builder", "--publish", "never", `-c.extraMetadata.version=${version}`, ...process.argv.slice(2)]);
