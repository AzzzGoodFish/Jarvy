import type { WorkEnvironment } from "./environment.js";
import type { Masker } from "./secret-mask.js";

/** Default seconds `bash` waits before detaching a long-running command into the background (A98). */
export const DEFAULT_BASH_WAIT_SECONDS = 30;
/** Max timeout accepted by `bash`, matching Pi's timer limit. */
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483.647;
/** Default and max seconds `bash_job(wait)` blocks before returning. */
export const DEFAULT_JOB_WAIT_SECONDS = 30;
export const MAX_JOB_WAIT_SECONDS = 600;

export type JobStatus = "running" | "done" | "failed" | "stopped" | "timed_out";

/** Summary of a currently running background command, carried in the tail of a Bot's batch (A98). */
export interface RunningJobSummary {
  id: string;
  command: string;
  env: string;
  startedAt: number;
}

/** What a Bot is told via a queued system notice when a background command exits (A98). */
export interface JobNoticePayload {
  id: string;
  status: Exclude<JobStatus, "running">;
  command: string;
  env: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  totalLines: number;
  fullOutputPath?: string;
  error?: string;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  command: string;
  env: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  exitCode: number | null;
  totalLines: number;
  fullOutputPath?: string;
  error?: string;
}

export interface JobStartInput {
  /** Original command as written by the Bot (never carrying resolved secret values). */
  displayCommand: string;
  /** Command handed to the environment's shell (with secret placeholders rewritten). */
  execCommand: string;
  env: WorkEnvironment;
  envName: string;
  cwd: string;
  /** Optional hard timeout in seconds that terminates the command. */
  timeout?: number;
  shellEnv?: Record<string, string>;
  secrets?: Record<string, string>;
  masker?: Masker;
}

export interface JobTailSnapshot {
  output: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  lastLineBytes?: number;
  fullOutputPath?: string;
}

export type JobWaitResult =
  | (JobTailSnapshot & {
      state: "finished";
      id: string;
      status: Exclude<JobStatus, "running">;
      exitCode: number | null;
      durationMs: number;
      structuredOutput: string;
      structuredTruncated: boolean;
      error?: string;
    })
  | (JobTailSnapshot & {
      state: "running";
      id: string;
      detachedBy: "immediate" | "wait_timeout" | "interrupt";
      durationMs: number;
      env: string;
    });

export interface JobReadResult {
  id: string;
  status: JobStatus;
  command: string;
  env: string;
  durationMs: number;
  exitCode: number | null;
  fromLine: number;
  toLine: number;
  totalLines: number;
  hasMore: boolean;
  output: string;
  droppedLines: number;
  fullOutputPath?: string;
  error?: string;
}

export interface JobStopResult {
  id: string;
  status: Exclude<JobStatus, "running">;
  alreadyFinished: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  totalLines: number;
  fullOutputPath?: string;
}

/** Per-Bot manager of background-capable bash commands (A98); kept behind this port so `infra/pi` never imports `service`. */
export interface CommandJobs {
  start(input: JobStartInput): string;
  wait(id: string, options: { waitMs: number; signal?: AbortSignal; onProgress?: (snapshot: JobTailSnapshot) => void }): Promise<JobWaitResult>;
  read(id: string, options?: { fromLine?: number; limit?: number }): Promise<JobReadResult>;
  list(): JobSummary[];
  stop(id: string): Promise<JobStopResult>;
  running(): RunningJobSummary[];
  stopAll(): Promise<void>;
}
