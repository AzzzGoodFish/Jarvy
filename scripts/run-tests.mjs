import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const entries = readdirSync("tests").filter(file => file.endsWith(".test.ts")).map(file => join("tests", file));
if (!entries.length) process.exit(0);

const outdir = mkdtempSync(join(tmpdir(), "jarvy-tests-"));
try {
  await build({
    entryPoints: entries,
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
  const built = entries.map(entry => join(outdir, entry.replace(/^tests\//, "").replace(/\.ts$/, ".mjs")));
  execFileSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
