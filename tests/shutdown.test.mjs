import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { runBounded } from "../.test-dist/server/shared/shutdown.js";
import { createServerShutdown } from "../.test-dist/server/shutdown.js";
import { S3Client } from "../.test-dist/server/infra/cloud/s3-client.js";
import { CloudLease } from "../.test-dist/server/infra/cloud/lease.js";
import { Store } from "../.test-dist/server/infra/storage/store.js";

test("runBounded resolves ok, timeout, and error without throwing", async () => {
  const logs = [];
  const ok = await runBounded("fast", 500, async () => "done", m => logs.push(m));
  assert.equal(ok.status, "ok");

  const hung = await runBounded("stalled", 40, () => new Promise(() => {}), m => logs.push(m));
  assert.equal(hung.status, "timeout");
  assert.match(logs.join("\n"), /step=stalled timeout/);

  const failed = await runBounded("boom", 500, async () => { throw new Error("kaboom"); }, m => logs.push(m));
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "kaboom");
});

test("createServerShutdown enforces strict phase order and post-release respawn on update", async () => {
  const events = [];
  const logs = [];
  let exitCode = null;

  const ctrl = createServerShutdown({
    setDraining: v => events.push(`draining:${v}`),
    stopAccepting: () => events.push("stopAccepting"),
    closeServices: async () => { events.push("closeServices"); return []; },
    closeNetwork: () => events.push("closeNetwork"),
    closeStorage: async () => { events.push("closeStorage"); return []; },
    removePidFile: () => events.push("removePidFile"),
    respawn: () => events.push("respawn"),
    exit: code => { exitCode = code; events.push(`exit:${code}`); },
    log: m => logs.push(m),
    budgets: { drainGraceMs: 10, wsCloseGraceMs: 10, serviceTimeoutMs: 200, syncTimeoutMs: 200, releaseTimeoutMs: 200, watchdogMs: 2000 },
  });

  await ctrl.trigger("update");

  assert.deepEqual(events, [
    "draining:true",
    "stopAccepting",
    "closeServices",
    "closeNetwork",
    "closeStorage",
    "removePidFile",
    "respawn",
    "exit:0",
  ]);
  assert.equal(exitCode, 0);
  assert.match(logs.join("\n"), /\[shutdown\] complete in/);
});

test("createServerShutdown fires hard watchdog when a phase hangs forever", async () => {
  const events = [];
  const logs = [];
  let exitCode = null;

  const ctrl = createServerShutdown({
    setDraining: v => events.push(`draining:${v}`),
    stopAccepting: () => events.push("stopAccepting"),
    closeServices: () => new Promise(() => {}), // hangs forever
    closeNetwork: () => events.push("closeNetwork"),
    closeStorage: async () => { events.push("closeStorage"); return []; },
    removePidFile: () => events.push("removePidFile"),
    respawn: () => events.push("respawn"),
    exit: code => { exitCode = code; events.push(`exit:${code}`); },
    log: m => logs.push(m),
    budgets: { drainGraceMs: 5, wsCloseGraceMs: 5, watchdogMs: 60 },
  });

  void ctrl.trigger("update");
  await new Promise(r => setTimeout(r, 150));

  assert.equal(exitCode, 1);
  assert.ok(events.includes("closeNetwork"));
  assert.ok(events.includes("removePidFile"));
  assert.ok(events.includes("respawn"));
  assert.match(logs.join("\n"), /hard timeout after 60ms during phase=services/);
});

test("createServerShutdown escalates immediately on second SIGTERM", async () => {
  const events = [];
  let exitCode = null;

  const ctrl = createServerShutdown({
    setDraining: () => {},
    stopAccepting: () => {},
    closeServices: () => new Promise(() => {}),
    closeNetwork: () => events.push("closeNetwork"),
    closeStorage: async () => [],
    removePidFile: () => events.push("removePidFile"),
    respawn: () => events.push("respawn"),
    exit: code => { exitCode = code; events.push(`exit:${code}`); },
    log: () => {},
    budgets: { drainGraceMs: 5, wsCloseGraceMs: 5, watchdogMs: 5000 },
  });

  ctrl.handleSignal("SIGTERM");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(exitCode, null);

  ctrl.handleSignal("SIGTERM");
  assert.equal(exitCode, 143);
  assert.ok(events.includes("closeNetwork"));
  assert.ok(events.includes("removePidFile"));
  assert.ok(!events.includes("respawn"));
});

test("S3Client enforces default timeout and CloudLease.release frees lease for immediate takeover", async () => {
  // 1. Stalled mock server that never responds
  const stalledSockets = new Set();
  const blackhole = createServer((_req, res) => {
    stalledSockets.add(res.socket);
  });
  await new Promise(r => blackhole.listen(0, "127.0.0.1", r));
  const blackholePort = blackhole.address().port;

  try {
    const slowS3 = new S3Client({
      bucket: "test",
      endpoint: `http://127.0.0.1:${blackholePort}`,
      region: "auto",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      pathStyle: true,
      timeoutMs: 1_000,
    });
    const t0 = Date.now();
    await assert.rejects(() => slowS3.get("lease.json", { signal: AbortSignal.timeout(120) }));
    assert.ok(Date.now() - t0 < 800, "S3Client should abort promptly on shutdown signal");
  } finally {
    for (const s of stalledSockets) s.destroy();
    await new Promise(r => blackhole.close(r));
  }

  // 2. Working mock S3 server verifying clean release + instant epoch+1 acquisition
  let stored = null;
  let etagSeq = 0;
  const mockS3 = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "GET") {
        if (!stored) { res.writeHead(404).end(); return; }
        res.writeHead(200, { etag: stored.etag }).end(stored.body);
        return;
      }
      if (req.method === "PUT") {
        const ifMatch = req.headers["if-match"];
        if (ifMatch && stored?.etag !== ifMatch) { res.writeHead(412).end("conflict"); return; }
        stored = { body, etag: `"e${++etagSeq}"` };
        res.writeHead(200, { etag: stored.etag }).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise(r => mockS3.listen(0, "127.0.0.1", r));
  const mockPort = mockS3.address().port;

  try {
    const s3 = new S3Client({
      bucket: "test",
      endpoint: `http://127.0.0.1:${mockPort}`,
      region: "auto",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      pathStyle: true,
    });
    const lease1 = new CloudLease({ s3, key: "lease.json", ttlMs: 60_000, onLost: () => {}, log: () => {} });
    const first = await lease1.acquire(false);
    assert.equal(first.epoch, 1);

    await lease1.release(AbortSignal.timeout(2_000));
    assert.equal(lease1.active, false);

    // Second server acquires immediately without --takeover and without waiting 60s
    const lease2 = new CloudLease({ s3, key: "lease.json", ttlMs: 60_000, onLost: () => {}, log: () => {} });
    const second = await lease2.acquire(false);
    assert.equal(second.epoch, 2);
    await lease2.release(AbortSignal.timeout(2_000));
  } finally {
    await new Promise(r => mockS3.close(r));
  }
});

test("real jarvy server run handles SIGTERM cleanly and releases lock/port for immediate restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvy-shutdown-e2e-"));
  const cli = resolve("dist/server/cli.js");

  // Initialize account in isolated temp data dir so server run starts non-interactively
  const initStore = new Store(dir);
  initStore.account.initialize("admin", "ShutdownTest123!");
  initStore.close();

  // Pick a free ephemeral port
  const probe = createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));

  const startAndStop = async () => {
    const child = spawn(process.execPath, [cli, "server", "run", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dir, "--no-web"], {
      env: { ...process.env, JARVY_UPDATE_CHECK: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d.toString(); });
    child.stderr.on("data", d => { output += d.toString(); });

    // Wait for server to print listening line
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`Server start timeout:\n${output}`)), 10_000);
      const onData = () => {
        if (output.includes("Jarvy server running at")) {
          clearTimeout(timer);
          resolveReady();
        }
      };
      child.stdout.on("data", onData);
      child.once("exit", code => { clearTimeout(timer); rejectReady(new Error(`Exited early (${code}):\n${output}`)); });
    });

    const tStop = Date.now();
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); rejectExit(new Error(`Shutdown hung:\n${output}`)); }, 8_000);
      child.once("close", code => { clearTimeout(timer); resolveExit(code); });
    });
    return { exitCode, elapsedMs: Date.now() - tStop, output };
  };

  try {
    const first = await startAndStop();
    assert.equal(first.exitCode, 0, `First run exit non-zero:\n${first.output}`);
    assert.ok(first.elapsedMs < 4_000, `First shutdown too slow (${first.elapsedMs}ms)`);
    assert.match(first.output, /\[shutdown\] complete in \d+ms \(reason=signal, drain=\d+ms, services=\d+ms, network=\d+ms, storage=\d+ms\)/);
    assert.equal(existsSync(join(dir, "jarvy.pid")), false);
    assert.equal(existsSync(join(dir, ".runtime.lock")), false);

    // Immediately start a second instance on the exact same port & data dir (verifies zero lock/port leak)
    const second = await startAndStop();
    assert.equal(second.exitCode, 0, `Second run failed (lock/port leak?):\n${second.output}`);
    assert.match(second.output, /\[shutdown\] complete in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
