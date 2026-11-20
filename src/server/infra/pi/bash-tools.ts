import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkEnvironment } from "../../shared/environment.js";
import {
  DEFAULT_BASH_WAIT_SECONDS, DEFAULT_JOB_WAIT_SECONDS, MAX_BASH_TIMEOUT_SECONDS,
  MAX_JOB_WAIT_SECONDS, type CommandJobs, type JobTailSnapshot,
} from "../../shared/jobs.js";
import type { SecretAccess } from "../../shared/secret.js";
import { rewritePlaceholders, secretVariable } from "./secret-placeholders.js";

const UPDATE_THROTTLE_MS = 150;

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  waitSeconds: Type.Optional(Type.Number({
    description: `Seconds to wait before detaching to background (default ${DEFAULT_BASH_WAIT_SECONDS}; 0 starts in background immediately)`,
  })),
  timeout: Type.Optional(Type.Number({ description: "Optional hard timeout in seconds; kills the command if exceeded" })),
});

const bashOutputSchema = Type.Object({
  output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
  truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
  exit_code: Type.Optional(Type.Number({ description: "Exit code when finished; omitted while still running in background" })),
  wall_time_seconds: Type.Number(),
  status: Type.Optional(Type.String({ description: "running when detached to background, done or failed when finished" })),
  job_id: Type.Optional(Type.String({ description: "Job ID for bash_job when still running in background" })),
});

const bashJobSchema = Type.Object({
  action: Type.Unsafe<"list" | "read" | "wait" | "stop">({
    type: "string",
    enum: ["list", "read", "wait", "stop"],
    description: "Operation to perform: list, read, wait, or stop",
  }),
  jobId: Type.Optional(Type.String({ description: "Job ID (e.g. j1), required for read, wait, and stop" })),
  fromLine: Type.Optional(Type.Number({ description: "For read: 1-based starting line number (omit to read the latest lines)" })),
  limit: Type.Optional(Type.Number({ description: "For read: max lines to return (default 200, max 2000)" })),
  waitSeconds: Type.Optional(Type.Number({
    description: `For wait: max seconds to wait (default ${DEFAULT_JOB_WAIT_SECONDS}, max ${MAX_JOB_WAIT_SECONDS})`,
  })),
});

export interface BashCallContext {
  env: WorkEnvironment;
  name: string;
  toolCallId: string | null;
}

/** Background-capable `bash` and standalone `bash_job` tools (A98). Short commands return synchronously as Pi's bash
 * does; long commands or commands hit by a turn interrupt detach without killing the process and auto-notify on exit. */
export function bashTools(current: () => BashCallContext, jobs: CommandJobs, secrets?: SecretAccess): ToolDefinition[] {
  const bash: ToolDefinition = {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr (truncated to last 2000 lines or 50KB; full output saved to a temp file when truncated). Waits up to waitSeconds (default ${DEFAULT_BASH_WAIT_SECONDS}; 0 starts in background immediately). If still running after waitSeconds, or if a new message interrupts the turn, the command stays running in the background and returns a job ID — you are notified automatically when it finishes, and can inspect, wait on, or stop it with bash_job. Optionally provide a hard timeout in seconds to kill the command if it runs too long.`,
    promptSnippet: "Execute bash commands (detaches long commands to background automatically)",
    parameters: bashSchema,
    outputSchema: bashOutputSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
      ctx: unknown,
    ) => {
      const params = rawParams as { command: string; waitSeconds?: number; timeout?: number };
      const { env, name, toolCallId } = current();
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd || env.cwd;
      const waitSeconds = resolveWaitSeconds(params.waitSeconds);
      const timeout = resolveTimeout(params.timeout);
      const prepared = withSecrets(params.command, secrets);
      if (prepared.names.length) {
        secrets!.record(prepared.names, { environmentId: env.id, toolCallId, detail: params.command });
      }
      const jobId = jobs.start({
        displayCommand: params.command, execCommand: prepared.command, env, envName: name, cwd,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(prepared.values ? { secrets: prepared.values } : {}),
        masker: secrets?.masker(),
      });
      const progress = onUpdate ? createProgressEmitter(onUpdate) : undefined;
      try {
        const result = await jobs.wait(jobId, { waitMs: waitSeconds * 1000, signal, onProgress: progress?.push });
        progress?.stop();
        const wallSec = Math.round(result.durationMs / 100) / 10;
        if (result.state === "running") {
          const reason = result.detachedBy === "immediate" ? "started in background"
            : result.detachedBy === "interrupt" ? `turn interrupted after ${wallSec}s, still running in background`
            : `still running after ${wallSec}s, detached to background`;
          const header = `[running] job=${result.id} (${reason}; you will be notified automatically when it exits)\n`
            + `Use bash_job(action="read"|"wait"|"stop", jobId="${result.id}") to inspect, wait, or stop it.`;
          const body = formatTail(result, "(no output yet)");
          return {
            content: [{ type: "text", text: `${header}\n\n${body}` }],
            details: { jobId: result.id, status: "running", ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}) },
            structuredContent: {
              output: result.output, truncated: result.truncated,
              ...(result.fullOutputPath ? { full_output_path: result.fullOutputPath } : {}),
              wall_time_seconds: wallSec, status: "running", job_id: result.id,
            },
          };
        }
        if (result.status === "timed_out") {
          throw new Error(appendStatus(formatTail(result, ""), result.error ?? `Command timed out after ${timeout} seconds`));
        }
        if (result.status === "failed" && result.exitCode === null && result.error) {
          throw new Error(appendStatus(formatTail(result, ""), result.error));
        }
        if (result.exitCode === null) {
          throw new Error(appendStatus(formatTail(result), "Command terminated without an exit code"));
        }
        const outputText = formatTail(result);
        const details = result.truncated ? { fullOutputPath: result.fullOutputPath } : undefined;
        const structuredContent = {
          output: result.structuredOutput,
          truncated: result.structuredTruncated,
          ...(result.structuredTruncated && result.fullOutputPath ? { full_output_path: result.fullOutputPath } : {}),
          exit_code: result.exitCode,
          wall_time_seconds: wallSec,
          status: result.exitCode === 0 ? "done" : "failed",
          job_id: result.id,
        };
        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${result.exitCode}`) }],
            details, structuredContent, isError: true,
          };
        }
        return { content: [{ type: "text", text: outputText }], details, structuredContent };
      } finally {
        progress?.stop();
      }
    },
  } as unknown as ToolDefinition;

  const bashJob: ToolDefinition = {
    name: "bash_job",
    label: "bash_job",
    description: "Manage background bash commands started by bash. Actions: list (show running and recent finished jobs), read (read output lines by jobId, with optional 1-based fromLine and limit), wait (wait up to waitSeconds, default 30, without killing on interrupt), stop (terminate a running job).",
    promptSnippet: "List, read, wait on, or stop background bash jobs",
    parameters: bashJobSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    execute: async (_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined) => {
      const params = rawParams as { action: "list" | "read" | "wait" | "stop"; jobId?: string; fromLine?: number; limit?: number; waitSeconds?: number };
      switch (params.action) {
        case "list": {
          const all = jobs.list();
          if (!all.length) return textResult("No background commands.");
          const lines = all.map(job => {
            const sec = (job.durationMs / 1000).toFixed(1);
            const exit = job.exitCode !== null ? ` exit=${job.exitCode}` : "";
            const log = job.fullOutputPath ? ` log=${job.fullOutputPath}` : "";
            return `${job.id} [${job.status}] ${sec}s${exit} lines=${job.totalLines} env=${job.env}${log} :: ${job.command}`;
          });
          return textResult(lines.join("\n"));
        }
        case "read": {
          const id = requireJobId(params.jobId, "read");
          if (params.fromLine !== undefined && (!Number.isFinite(params.fromLine) || params.fromLine < 1)) {
            throw new Error("Invalid fromLine: must be a positive integer");
          }
          if (params.limit !== undefined && (!Number.isFinite(params.limit) || params.limit < 1)) {
            throw new Error("Invalid limit: must be a positive integer");
          }
          const res = await jobs.read(id, { fromLine: params.fromLine, limit: params.limit });
          const sec = (res.durationMs / 1000).toFixed(1);
          const exit = res.exitCode !== null ? `, exit ${res.exitCode}` : "";
          const more = res.hasMore ? ", more available" : "";
          const notes: string[] = [];
          if (params.fromLine !== undefined && params.fromLine <= res.droppedLines) {
            notes.push(`[Lines 1-${res.droppedLines} were evicted from memory.${res.fullOutputPath ? ` Full output: ${res.fullOutputPath}` : ""}]`);
          } else if (res.fullOutputPath) {
            notes.push(`[Full output: ${res.fullOutputPath}]`);
          }
          if (res.error) notes.push(`[Error: ${res.error}]`);
          const head = `[${res.status}] job=${res.id} (${sec}s${exit}, lines ${res.fromLine}-${res.toLine} of ${res.totalLines}${more}) env=${res.env}`;
          return textResult([head, ...notes, "", res.output || "(no output)"].join("\n"));
        }
        case "wait": {
          const id = requireJobId(params.jobId, "wait");
          const waitSeconds = params.waitSeconds ?? DEFAULT_JOB_WAIT_SECONDS;
          if (!Number.isFinite(waitSeconds) || waitSeconds <= 0 || waitSeconds > MAX_JOB_WAIT_SECONDS) {
            throw new Error(`Invalid waitSeconds: must be between 1 and ${MAX_JOB_WAIT_SECONDS}`);
          }
          const res = await jobs.wait(id, { waitMs: waitSeconds * 1000, signal });
          const sec = (res.durationMs / 1000).toFixed(1);
          if (res.state === "running") {
            const reason = res.detachedBy === "interrupt" ? `turn interrupted after ${sec}s, still running in background`
              : `still running after ${sec}s`;
            return textResult(`[running] job=${res.id} (${reason}; you will be notified automatically when it exits)\n\n${formatTail(res, "(no output yet)")}`);
          }
          const exit = res.exitCode !== null ? `, exit ${res.exitCode}` : "";
          const err = res.error ? `${res.error}\n\n` : "";
          return textResult(`[${res.status}] job=${res.id} (${sec}s${exit})\n\n${err}${formatTail(res, "(no output)")}`);
        }
        case "stop": {
          const id = requireJobId(params.jobId, "stop");
          const res = await jobs.stop(id);
          const sec = (res.durationMs / 1000).toFixed(1);
          const exit = res.exitCode !== null ? `, exit ${res.exitCode}` : "";
          const label = res.alreadyFinished ? `already ${res.status}` : res.status;
          const log = res.fullOutputPath ? ` [Full output: ${res.fullOutputPath}]` : "";
          return textResult(`[${label}] job=${res.id} (${sec}s${exit}, ${res.totalLines} lines)${log}\n\n${res.output || "(no output)"}`);
        }
      }
    },
  } as unknown as ToolDefinition;

  return [bash, bashJob];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function requireJobId(jobId: string | undefined, action: string): string {
  const id = jobId?.trim();
  if (!id) throw new Error(`jobId is required for bash_job(action="${action}")`);
  return id;
}

function resolveWaitSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BASH_WAIT_SECONDS;
  if (!Number.isFinite(value) || value < 0 || value > MAX_BASH_TIMEOUT_SECONDS) {
    throw new Error(`Invalid waitSeconds: must be between 0 and ${MAX_BASH_TIMEOUT_SECONDS}`);
  }
  return value;
}

function resolveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_BASH_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: must be between 0 and ${MAX_BASH_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

/** The command to run, with placeholders turned into variables, and the values those variables take (A52). */
function withSecrets(command: string, secrets: SecretAccess | undefined): { command: string; names: string[]; values?: Record<string, string> } {
  const rewritten = rewritePlaceholders(command);
  if ("error" in rewritten) throw new Error(rewritten.error);
  if (!rewritten.names.length) return { command, names: [] };
  const resolved = secrets?.resolve(rewritten.names) ?? { refused: rewritten.names };
  if ("refused" in resolved) {
    throw new Error(`You may not use ${resolved.refused.join(", ")}. secrets.list in the chat gateway shows your owner's secrets and which of them you may use; ask for one with secrets.request, never for a value in the chat.`);
  }
  return {
    command: rewritten.command,
    names: rewritten.names,
    values: Object.fromEntries(Object.entries(resolved.values).map(([name, value]) => [secretVariable(name), value])),
  };
}

function formatTail(snap: JobTailSnapshot, emptyText = "(no output)"): string {
  let text = snap.output || emptyText;
  if (!snap.truncated) return text;
  const startLine = Math.max(1, snap.totalLines - snap.outputLines + 1);
  const endLine = snap.totalLines;
  const where = snap.fullOutputPath ? ` Full output: ${snap.fullOutputPath}` : "";
  if (snap.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(snap.outputBytes)} of line ${endLine} (line is ${formatSize(snap.lastLineBytes ?? snap.outputBytes)}).${where}]`;
  } else if (snap.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${snap.totalLines}.${where}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${snap.totalLines} (50.0KB limit).${where}]`;
  }
  return text;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

function createProgressEmitter(onUpdate: (partial: { content: { type: "text"; text: string }[]; details: unknown }) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: JobTailSnapshot | null = null;
  let lastEmit = 0;
  let stopped = false;
  const flush = () => {
    if (stopped || !latest) return;
    const snap = latest;
    latest = null;
    lastEmit = Date.now();
    onUpdate({ content: [{ type: "text", text: snap.output }], details: snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : undefined });
  };
  return {
    push: (snap: JobTailSnapshot) => {
      if (stopped) return;
      latest = snap;
      const delay = UPDATE_THROTTLE_MS - (Date.now() - lastEmit);
      if (delay <= 0) { if (timer) { clearTimeout(timer); timer = undefined; } flush(); return; }
      timer ??= setTimeout(() => { timer = undefined; flush(); }, delay);
    },
    stop: () => {
      stopped = true;
      latest = null;
      if (timer) { clearTimeout(timer); timer = undefined; }
    },
  };
}
