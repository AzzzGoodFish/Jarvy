import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { WorkEnvironment } from "../../shared/environment.js";
import type {
  CommandJobs, JobNoticePayload, JobReadResult, JobStartInput, JobStatus,
  JobStopResult, JobSummary, JobTailSnapshot, JobWaitResult, RunningJobSummary,
} from "../../shared/jobs.js";
import { StreamMask } from "../../shared/secret-mask.js";

/** Limits matching Pi's built-in bash tool for model-facing tail output. */
const TAIL_MAX_LINES = 2000;
const TAIL_MAX_BYTES = 50 * 1024;
/** Programmatic output limit for codemode structuredContent. */
const STRUCTURED_MAX_BYTES = 1024 * 1024;
/** Compact output carried inside a completion notice envelope. */
const NOTICE_MAX_LINES = 40;
const NOTICE_MAX_BYTES = 4 * 1024;
/** Per-job in-memory ring buffer caps; full output spills to `env.temp` once tail limits are passed. */
const MAX_BUFFER_LINES = 10_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Default and upper line limits for `bash_job(read)`. */
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 2000;
/** Keep the newest finished jobs in memory for `bash_job(list|read)`. */
const MAX_FINISHED_JOBS = 50;
/** Max time `stop` / `stopAll` waits for a process to exit after aborting its signal. */
const STOP_WAIT_MS = 3_000;
/** Length cap for command previews in summaries and XML envelopes. */
const COMMAND_PREVIEW = 200;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu;

interface Waiter {
  onProgress?: (snapshot: JobTailSnapshot) => void;
  finish: (result: Extract<JobWaitResult, { state: "finished" }>) => void;
}

interface JobRecord {
  id: string;
  command: string;
  env: WorkEnvironment;
  envName: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  status: JobStatus;
  exitCode: number | null;
  error?: string;
  controller: AbortController;
  exited: boolean;
  stopRequested: boolean;
  lines: string[];
  partial: string;
  droppedLines: number;
  bufferBytes: number;
  totalBytes: number;
  spillPath: string | null;
  spillFailed: boolean;
  spillChain: Promise<void>;
  waiters: Set<Waiter>;
  done: Promise<void>;
  resolveDone: () => void;
}

/** Per-Bot background command manager (A98). Commands run on their own AbortController so turn interrupts detach
 * without killing the process; when a detached job finishes, `onFinished` notifies the Bot through Deliveries. */
export class BotJobs implements CommandJobs {
  private readonly jobs = new Map<string, JobRecord>();
  /** Random per-instance prefix so job IDs and temp log files never collide across restarts (A98). */
  private readonly prefix = randomBytes(3).toString("hex");
  private counter = 0;

  constructor(private readonly onFinished: (payload: JobNoticePayload) => void) {}

  start(input: JobStartInput): string {
    const id = `j-${this.prefix}-${++this.counter}`;
    const controller = new AbortController();
    let resolveDone = () => {};
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const job: JobRecord = {
      id, command: input.displayCommand, env: input.env, envName: input.envName || "sandbox", cwd: input.cwd,
      startedAt: Date.now(), endedAt: null, status: "running", exitCode: null, controller,
      exited: false, stopRequested: false, lines: [], partial: "", droppedLines: 0, bufferBytes: 0, totalBytes: 0,
      spillPath: null, spillFailed: false, spillChain: Promise.resolve(), waiters: new Set(), done, resolveDone,
    };
    this.jobs.set(id, job);
    this.launch(job, input);
    return id;
  }

  private launch(job: JobRecord, input: JobStartInput): void {
    const decoder = new StringDecoder("utf8");
    const emitText = (text: string) => {
      if (!text) return;
      this.appendText(job, text);
      if (job.waiters.size) {
        const snap = this.tail(job, TAIL_MAX_LINES, TAIL_MAX_BYTES);
        for (const waiter of job.waiters) waiter.onProgress?.(snap);
      }
    };
    const masker = input.masker && !input.masker.empty ? input.masker : null;
    const stream = masker ? new StreamMask(masker, chunk => emitText(chunk.toString("utf8"))) : null;
    const onData = (chunk: Buffer) => {
      if (stream) stream.push(chunk);
      else emitText(decoder.write(chunk));
    };

    void (async () => {
      let status: Exclude<JobStatus, "running"> = "done";
      let exitCode: number | null = null;
      let errorMessage: string | undefined;
      try {
        const res = await input.env.exec(input.execCommand, {
          cwd: input.cwd, onData, signal: controllerSignal(job),
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
          ...(input.shellEnv ? { env: input.shellEnv } : {}),
          ...(input.secrets ? { secrets: input.secrets } : {}),
        });
        exitCode = res.exitCode;
        status = exitCode === 0 ? "done" : "failed";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.stopRequested || message === "aborted") {
          status = "stopped";
        } else if (message.startsWith("timeout:")) {
          status = "timed_out";
          errorMessage = `Command timed out after ${message.slice("timeout:".length)} seconds`;
        } else {
          status = "failed";
          errorMessage = message;
        }
      } finally {
        job.exited = true;
        if (stream) stream.end();
        else { const rest = decoder.end(); if (rest) emitText(rest); }
        await job.spillChain;
        job.status = status;
        job.exitCode = exitCode;
        job.error = errorMessage;
        job.endedAt = Date.now();
        const hadWaiters = job.waiters.size > 0;
        if (hadWaiters) {
          const result = this.finishedResult(job);
          for (const waiter of [...job.waiters]) waiter.finish(result);
          job.waiters.clear();
        }
        job.resolveDone();
        this.pruneFinished();
        if (!job.stopRequested && !hadWaiters) this.onFinished(this.noticePayload(job));
      }
    })();
  }

  async wait(id: string, options: { waitMs: number; signal?: AbortSignal; onProgress?: (snapshot: JobTailSnapshot) => void }): Promise<JobWaitResult> {
    const job = this.requireJob(id);
    if (job.status !== "running") return this.finishedResult(job);
    if (options.waitMs <= 0) return this.runningResult(job, "immediate");
    if (options.signal?.aborted) return this.runningResult(job, "interrupt");

    return new Promise<JobWaitResult>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        options.signal?.removeEventListener("abort", onAbort);
        job.waiters.delete(waiter);
      };
      const detach = (reason: "wait_timeout" | "interrupt") => {
        if (settled || job.exited) return;
        settled = true;
        cleanup();
        resolve(this.runningResult(job, reason));
      };
      const onAbort = () => detach("interrupt");
      const waiter: Waiter = {
        onProgress: options.onProgress,
        finish: result => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
      };
      job.waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => detach("wait_timeout"), options.waitMs);
    });
  }

  async read(id: string, options?: { fromLine?: number; limit?: number }): Promise<JobReadResult> {
    const job = this.requireJob(id);
    await job.spillChain;
    const total = this.totalLines(job);
    const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(options?.limit ?? DEFAULT_READ_LINES)));
    const all = this.allLines(job);
    const firstBuffered = job.droppedLines + 1;
    const startLine = options?.fromLine !== undefined ? Math.max(1, Math.floor(options.fromLine)) : Math.max(firstBuffered, total - limit + 1);
    const effectiveStart = Math.max(startLine, firstBuffered);
    const startIdx = Math.min(all.length, Math.max(0, effectiveStart - firstBuffered));
    const slice: string[] = [];
    let bytes = 0;
    for (let i = startIdx; i < all.length && slice.length < limit; i++) {
      const line = all[i]!;
      const add = Buffer.byteLength(line, "utf8") + (slice.length ? 1 : 0);
      if (bytes + add > TAIL_MAX_BYTES && slice.length > 0) break;
      slice.push(slice.length === 0 && add > TAIL_MAX_BYTES ? sliceEndUtf8(line, TAIL_MAX_BYTES) : line);
      bytes += add;
    }
    const fromLine = slice.length ? firstBuffered + startIdx : startLine;
    const toLine = slice.length ? fromLine + slice.length - 1 : Math.min(total, startLine);
    return {
      id: job.id, status: job.status, command: clipCommand(job.command), env: job.envName,
      durationMs: (job.endedAt ?? Date.now()) - job.startedAt, exitCode: job.exitCode,
      fromLine, toLine, totalLines: total, hasMore: toLine < total,
      output: slice.join("\n"), droppedLines: job.droppedLines,
      ...(job.spillPath && !job.spillFailed ? { fullOutputPath: job.spillPath } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map(job => ({
      id: job.id, status: job.status, command: clipCommand(job.command), env: job.envName, cwd: job.cwd,
      startedAt: job.startedAt, endedAt: job.endedAt, durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      exitCode: job.exitCode, totalLines: this.totalLines(job),
      ...(job.spillPath && !job.spillFailed ? { fullOutputPath: job.spillPath } : {}),
      ...(job.error ? { error: job.error } : {}),
    }));
  }

  async stop(id: string): Promise<JobStopResult> {
    const job = this.requireJob(id);
    if (job.status !== "running") {
      const tail = this.tail(job, NOTICE_MAX_LINES, NOTICE_MAX_BYTES);
      return {
        id: job.id, status: job.status, alreadyFinished: true, exitCode: job.exitCode,
        durationMs: (job.endedAt ?? Date.now()) - job.startedAt, output: tail.output, totalLines: tail.totalLines,
        ...(tail.fullOutputPath ? { fullOutputPath: tail.fullOutputPath } : {}),
      };
    }
    job.stopRequested = true;
    job.controller.abort();
    await Promise.race([job.done, delay(STOP_WAIT_MS)]);
    const tail = this.tail(job, NOTICE_MAX_LINES, NOTICE_MAX_BYTES);
    const status = job.status === "running" ? "stopped" : job.status;
    return {
      id: job.id, status, alreadyFinished: false, exitCode: job.exitCode,
      durationMs: (job.endedAt ?? Date.now()) - job.startedAt, output: tail.output, totalLines: tail.totalLines,
      ...(tail.fullOutputPath ? { fullOutputPath: tail.fullOutputPath } : {}),
    };
  }

  running(): RunningJobSummary[] {
    const list: RunningJobSummary[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" && !job.exited) {
        list.push({ id: job.id, command: cleanXml(clipCommand(job.command)), env: cleanXml(job.envName) || "sandbox", startedAt: job.startedAt });
      }
    }
    return list;
  }

  async stopAll(reason?: string): Promise<JobNoticePayload[]> {
    const active: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" && !job.exited) {
        job.stopRequested = true;
        job.controller.abort();
        active.push(job);
      }
    }
    if (!active.length) return [];
    await Promise.race([Promise.all(active.map(job => job.done)), delay(STOP_WAIT_MS)]);
    return active.map(job => ({
      ...this.noticePayload(job),
      status: "stopped",
      ...(reason ? { error: cleanXml(reason) } : {}),
    }));
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job "${id}" (background jobs do not survive a server or Bot restart). Use bash_job(action="list") to see current jobs.`);
    return job;
  }

  private appendText(job: JobRecord, text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    job.totalBytes += bytes;
    const normalized = text.replace(/\r\n/g, "\n");
    const parts = (job.partial + normalized).split("\n");
    job.partial = parts.pop() ?? "";
    for (const line of parts) {
      job.lines.push(line);
      job.bufferBytes += Buffer.byteLength(line, "utf8") + 1;
    }
    // Start spilling before anything is evicted so the file holds the complete output from byte 0.
    if (!job.spillPath && !job.spillFailed && (job.totalBytes > TAIL_MAX_BYTES || this.totalLines(job) > TAIL_MAX_LINES)) {
      const path = `${job.env.temp ?? `${job.env.cwd}/temp`}/jarvy-job-${job.id}.log`;
      job.spillPath = path;
      const initial = this.allText(job);
      job.spillChain = job.spillChain.then(() => job.env.writeFile(path, initial)).catch(() => { job.spillFailed = true; });
    } else if (job.spillPath && !job.spillFailed) {
      const path = job.spillPath;
      const chunk = Buffer.from(text, "utf8");
      job.spillChain = job.spillChain.then(() => job.env.appendFile(path, chunk)).catch(() => { job.spillFailed = true; });
    }
    while (job.lines.length > MAX_BUFFER_LINES || (job.bufferBytes > MAX_BUFFER_BYTES && job.lines.length > 1)) {
      const removed = job.lines.shift()!;
      job.droppedLines++;
      job.bufferBytes -= Buffer.byteLength(removed, "utf8") + 1;
    }
  }

  private totalLines(job: JobRecord): number {
    return job.droppedLines + job.lines.length + (job.partial.length ? 1 : 0);
  }

  private allLines(job: JobRecord): string[] {
    return job.partial.length ? [...job.lines, job.partial] : job.lines;
  }

  private allText(job: JobRecord): string {
    if (!job.lines.length) return job.partial;
    return job.lines.join("\n") + (job.partial.length ? `\n${job.partial}` : "\n");
  }

  private tail(job: JobRecord, maxLines: number, maxBytes: number): JobTailSnapshot {
    const lines = this.allLines(job);
    const totalLines = this.totalLines(job);
    const fullOutputPath = job.spillPath && !job.spillFailed ? job.spillPath : undefined;
    if (!lines.length) {
      return { output: "", truncated: false, truncatedBy: null, totalLines: 0, outputLines: 0, outputBytes: 0, lastLinePartial: false, ...(fullOutputPath ? { fullOutputPath } : {}) };
    }
    const out: string[] = [];
    let outBytes = 0;
    let truncated = job.droppedLines > 0;
    let truncatedBy: "lines" | "bytes" | null = job.droppedLines > 0 ? "lines" : null;
    let lastLinePartial = false;
    let lastLineBytes: number | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= maxLines) { truncated = true; truncatedBy = "lines"; break; }
      const line = lines[i]!;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const add = lineBytes + (out.length ? 1 : 0);
      if (outBytes + add > maxBytes) {
        truncated = true;
        truncatedBy = "bytes";
        if (out.length === 0) {
          const piece = sliceEndUtf8(line, maxBytes);
          out.unshift(piece);
          outBytes = Buffer.byteLength(piece, "utf8");
          lastLinePartial = true;
          lastLineBytes = lineBytes;
        }
        break;
      }
      out.unshift(line);
      outBytes += add;
    }
    return {
      output: out.join("\n"), truncated, truncatedBy, totalLines, outputLines: out.length, outputBytes: outBytes,
      lastLinePartial, ...(lastLineBytes !== undefined ? { lastLineBytes } : {}), ...(fullOutputPath ? { fullOutputPath } : {}),
    };
  }

  private runningResult(job: JobRecord, detachedBy: "immediate" | "wait_timeout" | "interrupt"): Extract<JobWaitResult, { state: "running" }> {
    return {
      state: "running", id: job.id, detachedBy, durationMs: Date.now() - job.startedAt, env: job.envName,
      ...this.tail(job, TAIL_MAX_LINES, TAIL_MAX_BYTES),
    };
  }

  private finishedResult(job: JobRecord): Extract<JobWaitResult, { state: "finished" }> {
    const tail = this.tail(job, TAIL_MAX_LINES, TAIL_MAX_BYTES);
    const full = this.tail(job, MAX_BUFFER_LINES, STRUCTURED_MAX_BYTES);
    return {
      state: "finished", id: job.id, status: job.status === "running" ? "done" : job.status,
      exitCode: job.exitCode, durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      ...tail, structuredOutput: full.output, structuredTruncated: full.truncated,
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private noticePayload(job: JobRecord): JobNoticePayload {
    const tail = this.tail(job, NOTICE_MAX_LINES, NOTICE_MAX_BYTES);
    return {
      id: job.id, status: job.status === "running" ? "done" : job.status,
      command: cleanXml(clipCommand(job.command)) || "command",
      env: cleanXml(job.envName) || "sandbox",
      exitCode: job.exitCode, durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      output: cleanXml(tail.output), totalLines: tail.totalLines,
      ...(tail.fullOutputPath ? { fullOutputPath: cleanXml(tail.fullOutputPath) } : {}),
      ...(job.error ? { error: cleanXml(job.error) } : {}),
    };
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()].filter(job => job.status !== "running");
    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.shift()!;
      this.jobs.delete(oldest.id);
    }
  }
}

const controllerSignal = (job: JobRecord) => job.controller.signal;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function clipCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > COMMAND_PREVIEW ? `${oneLine.slice(0, COMMAND_PREVIEW - 1)}…` : oneLine;
}

/** Removes ANSI escape codes and characters forbidden in XML 1.0 text/attributes. */
function cleanXml(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(XML_INVALID, "");
}

function sliceEndUtf8(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}
