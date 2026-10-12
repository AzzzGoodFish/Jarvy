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
