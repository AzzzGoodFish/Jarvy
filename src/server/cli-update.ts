import { spawn } from "node:child_process";
import { compareSemver } from "../contract/update.js";
import { runningDaemon, stopDaemon } from "./daemon.js";
import { detectInstallMode, fetchLatestReleaseInfo, installNpmPackageVersion } from "./service/update.js";
import { currentJarvyVersion } from "./shared/version.js";

/** Runs `jarvy server update [--check] [--version <ver>]` and safely restarts a running background daemon (A113). */
export async function runServerUpdate(dir: string, rest: string[], pidFile: string): Promise<void> {
  const checkOnly = rest.includes("--check");
  const verIdx = rest.indexOf("--version");
  const inlineVer = rest.find(a => a.startsWith("--version="))?.slice("--version=".length);
  const explicitVer = inlineVer ?? (verIdx !== -1 ? rest[verIdx + 1] : undefined);

  const current = currentJarvyVersion();
  const mode = detectInstallMode();
  let target = explicitVer?.trim();
  let releaseUrl = "";

  if (!target) {
    const info = await fetchLatestReleaseInfo();
    target = info.version;
    releaseUrl = info.releaseUrl;
  }

  const newer = compareSemver(target, current) > 0;
  if (!explicitVer && !newer) {
    console.log(`Jarvy server is already up to date (v${current}).`);
    return;
  }
  if (checkOnly) {
    console.log(`Update available: v${target} (current: v${current})${releaseUrl ? `\nRelease: ${releaseUrl}` : ""}`);
    return;
  }
  if (mode === "git") {
    throw new Error(`Update v${target} is available, but Jarvy is running from a git checkout. Update with: git pull && npm run build`);
  }

  console.log(`Installing @goodfish/jarvy@${target} (current: v${current})...`);
  await installNpmPackageVersion(target);
  console.log(`Installed @goodfish/jarvy@${target}.`);

  const running = runningDaemon(dir, pidFile);
  if (running) {
    console.log(`Stopping running Jarvy server (pid ${running.pid}, flushing cloud sync)...`);
    const stopped = await stopDaemon(dir, pidFile, 60_000);
    if (stopped === "still_running") {
      throw new Error("Server did not stop in time; restart it manually once shutdown completes.");
    }
    console.log("Server stopped cleanly. Start it again with your usual `jarvy server start ...` or systemd unit.");
  }
}

/** Runs `jarvy client update [--check] [--version <ver>]` (A113). */
export async function runClientUpdate(dir: string, rest: string[], pidFile: string): Promise<void> {
  const checkOnly = rest.includes("--check");
  const verIdx = rest.indexOf("--version");
  const inlineVer = rest.find(a => a.startsWith("--version="))?.slice("--version=".length);
  const explicitVer = inlineVer ?? (verIdx !== -1 ? rest[verIdx + 1] : undefined);

  const current = currentJarvyVersion();
  const mode = detectInstallMode();
  const target = explicitVer?.trim() || (await fetchLatestReleaseInfo()).version;
  const newer = compareSemver(target, current) > 0;

  if (!explicitVer && !newer) {
    console.log(`Jarvy client is already up to date (v${current}).`);
    return;
  }
  if (checkOnly) {
    console.log(`Update available: v${target} (current: v${current}).`);
    return;
  }
  if (mode === "git") {
    throw new Error(`Update v${target} is available, but Jarvy is running from a git checkout. Update with: git pull && npm run build`);
  }

  console.log(`Installing @goodfish/jarvy@${target} (current: v${current})...`);
  await installNpmPackageVersion(target);
  console.log(`Installed @goodfish/jarvy@${target}.`);

  const running = runningDaemon(dir, pidFile);
  if (running) {
    console.log(`Stopping running Jarvy client (pid ${running.pid}; running sandboxes/VMs stay alive)...`);
    await stopDaemon(dir, pidFile, 30_000);
    console.log("Client stopped cleanly. Start it again with `jarvy client start ...` or let systemd restart it.");
  }
}

/** Respawns the current server/client process detached when not managed by systemd (`INVOCATION_ID` unset). */
export function respawnServerAfterShutdown(): void {
  if (process.env.INVOCATION_ID) return; // systemd Restart=always handles restart automatically.
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
