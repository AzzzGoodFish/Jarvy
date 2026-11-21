import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import xtermHeadless from "@xterm/headless";
import type { WebSocket } from "ws";
import type { TerminalServerMessage } from "../src/contract/terminal.ts";
import type { PtyExit, PtyHandle, PtyOpenOptions } from "../src/server/shared/terminal.ts";
import { TerminalService } from "../src/server/service/terminals.ts";

const { Terminal } = xtermHeadless;

interface FakePtyController {
  handle: PtyHandle;
  emit(text: string): void;
  exit(code: number | null, reason?: string): void;
  closed: boolean;
}

function createFakePty(options: PtyOpenOptions): FakePtyController {
  let resolveExit!: (exit: PtyExit) => void;
  const exited = new Promise<PtyExit>(resolve => { resolveExit = resolve; });
  let done = false;
  const controller: FakePtyController = {
    closed: false,
    emit(text: string) {
      if (!done) options.onData(Buffer.from(text, "utf8"));
    },
    exit(code: number | null, reason?: string) {
      if (done) return;
      done = true;
      resolveExit({ exitCode: code, ...(reason ? { reason } : {}) });
    },
    handle: {
      write() {},
      resize() {},
      close() {
        controller.closed = true;
        controller.exit(null, "closed");
      },
      exited,
    },
  };
  return controller;
}

/** In-memory WebSocket paired with a real `@xterm/headless` renderer replicating `TerminalCanvas.tsx` behavior. */
class TestViewer extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly term = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
  firstFrameKind: "snapshot" | "binary" | "other" | null = null;
  lastSnapshot: Extract<TerminalServerMessage, { t: "snapshot" }> | null = null;
  readonly controlMessages: TerminalServerMessage[] = [];
  private firstFrameResolve: (() => void) | null = null;
  readonly firstFrame: Promise<void>;

  constructor() {
    super();
    this.firstFrame = new Promise<void>(resolve => { this.firstFrameResolve = resolve; });
  }

  send(payload: string | Buffer): void {
    if (this.readyState !== this.OPEN) return;
    if (typeof payload === "string") {
      const msg = JSON.parse(payload) as TerminalServerMessage;
      this.controlMessages.push(msg);
      if (this.firstFrameKind === null) {
        this.firstFrameKind = msg.t === "snapshot" ? "snapshot" : "other";
        this.firstFrameResolve?.();
      }
      if (msg.t === "snapshot") {
        this.lastSnapshot = msg;
        this.term.reset();
        this.term.resize(msg.cols, msg.rows);
        this.term.write(msg.data);
      }
      return;
    }
    if (this.firstFrameKind === null) {
      this.firstFrameKind = "binary";
      this.firstFrameResolve?.();
    }
    this.term.write(new Uint8Array(payload));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void { this.close(); }

  async renderedLines(): Promise<string[]> {
    await new Promise<void>(resolve => this.term.write("", resolve));
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      if (text) lines.push(text);
    }
    return lines;
  }

  dispose(): void {
    this.close();
    this.term.dispose();
  }
}

test("reconnect under continuous streaming preserves every rendered line in exact order", async () => {
  let activePty: FakePtyController | null = null;
  const service = new TerminalService({
    openPty: async (_envId, options) => {
      activePty = createFakePty(options);
      return { pty: activePty.handle, cwd: "/tmp" };
    },
    changed: () => {},
  });

  const session = await service.create("env-stream", { cols: 100, rows: 30 });
  const continuous = new TestViewer();
  service.attach(session.id, continuous as unknown as WebSocket);

  const totalLines = 1500;
  let sent = 0;
  let reattached: TestViewer | null = null;

  // Emit numbered lines continuously while repeatedly detaching and reattaching a second viewer mid-stream.
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 15; i++) {
      sent++;
      activePty!.emit(`LINE ${String(sent).padStart(4, "0")}\r\n`);
    }
    reattached?.dispose();
    reattached = new TestViewer();
    service.attach(session.id, reattached as unknown as WebSocket);
    // Emit immediately AFTER attach() before xterm's async write barrier fires!
    for (let i = 0; i < 15; i++) {
      sent++;
      activePty!.emit(`LINE ${String(sent).padStart(4, "0")}\r\n`);
    }
    await reattached.firstFrame;
    assert.equal(reattached.firstFrameKind, "snapshot", `Round ${round + 1}: first frame must be snapshot, not live bytes`);
  }
  assert.equal(sent, totalLines);

  // Wait for async xterm flushes to settle on both viewers.
  await new Promise(resolve => setTimeout(resolve, 50));
  const contLines = (await continuous.renderedLines()).filter(line => line.startsWith("LINE "));
  const reattLines = (await reattached!.renderedLines()).filter(line => line.startsWith("LINE "));

  const expected = Array.from({ length: totalLines }, (_, i) => `LINE ${String(i + 1).padStart(4, "0")}`);
  assert.deepEqual(contLines, expected, "Continuous viewer should render every line exactly once");
  assert.deepEqual(reattLines, expected, "Reattached viewer should render every line identically with zero drops or duplicates");

  continuous.dispose();
  reattached!.dispose();
  service.closeAll();
});

test("failed restart preserves scrollback and exited state; live and concurrent restarts are rejected", async () => {
  let mode: "ok" | "fail" | "slow" = "ok";
  let releaseSlow: (() => void) | null = null;
  let openedCount = 0;
  let lastPty: FakePtyController | null = null;

  const service = new TerminalService({
    openPty: async (_envId, options) => {
      openedCount++;
      if (mode === "fail") throw new Error("ENOENT: working directory missing");
      if (mode === "slow") {
        await new Promise<void>(resolve => { releaseSlow = resolve; });
      }
      lastPty = createFakePty(options);
      return { pty: lastPty.handle, cwd: "/tmp" };
    },
    changed: () => {},
  });

  const session = await service.create("env-restart", { cols: 80, rows: 24 });
  lastPty!.emit("PREV_LINE_A\r\nPREV_LINE_B\r\n");

  // Restarting a running session must be rejected without overwriting its live PTY.
  await assert.rejects(() => service.restart(session.id), /still running/i);
  assert.equal(openedCount, 1);
  assert.equal(service.get(session.id).state, "running");

  // Normal exit.
  lastPty!.exit(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get(session.id).state, "exited");
  assert.equal(service.get(session.id).exitCode, 0);

  // Failed restart must keep state=exited, exitCode=0, and all previous scrollback intact!
  mode = "fail";
  await assert.rejects(() => service.restart(session.id, { cols: 120, rows: 40 }), /ENOENT/);
  const afterFail = service.get(session.id);
  assert.equal(afterFail.state, "exited");
  assert.equal(afterFail.exitCode, 0);
  assert.equal(afterFail.cols, 80);
  assert.equal(afterFail.rows, 24);

  const reloadViewer = new TestViewer();
  service.attach(session.id, reloadViewer as unknown as WebSocket);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reloadViewer.lastSnapshot?.state, "exited");
  assert.deepEqual(await reloadViewer.renderedLines(), ["PREV_LINE_A", "PREV_LINE_B"]);

  // Serialize concurrent restarts: second call rejects while first is in flight.
  mode = "slow";
  const firstRestart = service.restart(session.id, { cols: 110, rows: 35 });
  await assert.rejects(() => service.restart(session.id), /already restarting/i);
  releaseSlow!();
  const restarted = await firstRestart;
  assert.equal(restarted.state, "running");
  assert.equal(restarted.cols, 110);
  assert.equal(restarted.rows, 35);

  lastPty!.emit("FRESH_AFTER_RESTART\r\n");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await reloadViewer.renderedLines(), ["FRESH_AFTER_RESTART"]);

  reloadViewer.dispose();
  service.closeAll();
});

test("pending creation reservations enforce per-environment limits and cancel on environment teardown", async () => {
  const gates: Array<() => void> = [];
  const createdPtys: FakePtyController[] = [];
  const service = new TerminalService({
    openPty: async (_envId, options) => {
      await new Promise<void>(resolve => { gates.push(resolve); });
      const fake = createFakePty(options);
      createdPtys.push(fake);
      return { pty: fake.handle, cwd: "/tmp" };
    },
    changed: () => {},
  });

  // 20 simultaneous creates on one environment: only 16 may reserve slots; 4 fail immediately with terminal_limit.
  const attempts = Array.from({ length: 20 }, () => service.create("env-cap"));
  // Wait a tick for limit rejections to settle while the 16 valid ones stay pending.
  const settledEarly = await Promise.allSettled(attempts.slice(16));
  for (const res of settledEarly) {
    assert.equal(res.status, "rejected");
    assert.equal((res.reason as { code?: string }).code, "terminal_limit");
  }
  assert.equal(gates.length, 16, "Exactly 16 openPty calls should be started");
  while (gates.length) gates.shift()!();
  const ok = await Promise.all(attempts.slice(0, 16));
  assert.equal(ok.length, 16);
  assert.equal(service.list("env-cap").length, 16);

  // Environment teardown during an in-flight create cancels the reservation and closes the late-resolved PTY.
  const pendingCreate = service.create("env-teardown");
  assert.equal(gates.length, 1);
  service.closeForEnvironment("env-teardown");
  gates.shift()!();
  await assert.rejects(() => pendingCreate, /closed|not found/i);
  assert.equal(service.list("env-teardown").length, 0);
  assert.equal(createdPtys.at(-1)?.closed, true, "Late-resolved PTY must be closed when environment tore down");

  service.closeAll();
});
