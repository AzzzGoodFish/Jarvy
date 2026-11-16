// Bundles the server into one dist/server/cli.js (readable, so stack traces in bug reports make sense). npm dependencies stay external.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist/server", { recursive: true, force: true });
await build({
  entryPoints: ["src/server/cli.ts"],
  outfile: "dist/server/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
// The command-line client that connects a computer to Jarvy (A96): one file with its own dependency (ws) inside, which
// Jarvy serves to computers, for Node 22 or later.
await build({
  entryPoints: ["src/connect/main.ts"],
  outfile: "dist/server/connector.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
