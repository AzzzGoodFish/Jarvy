import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, Loader2Icon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { updateStore, type UpdateJob, type UpdateJobStage } from "./update-store";

type StepState = "pending" | "active" | "done" | "error";

interface TimelineStep {
  id: string;
  label: string;
  state: StepState;
  meta?: string;
  detail?: string | null;
  progressPct?: number | null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function stageOrder(stage: UpdateJobStage): number {
  switch (stage) {
    case "server_installing": return 1;
    case "server_restarting": return 2;
    case "server_reconnecting": return 2;
    case "desktop_downloading": return 3;
    case "desktop_verifying": return 3;
    case "desktop_installing": return 4;
    case "completed": return 5;
    case "error": return -1;
  }
}

function buildSteps(job: UpdateJob, now: number): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const ord = stageOrder(job.stage);
  const elapsed = formatElapsed(job.startedAt, now);
  const pct = job.totalBytes && job.totalBytes > 0
    ? Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100))
    : null;

  if (job.mode === "server" || job.mode === "both") {
    const s1: StepState = job.stage === "error"
      ? (job.bytesReceived > 0 ? "done" : "error")
      : ord > 1 ? "done" : ord === 1 ? "active" : "pending";
    steps.push({
      id: "server_install",
      label: t("about.stepServerInstall"),
      state: s1,
      meta: s1 === "active" ? elapsed : undefined,
      detail: s1 === "active" ? job.detail : null,
      progressPct: s1 === "active" ? null : undefined,
    });

    const s2: StepState = job.stage === "error"
      ? (job.bytesReceived > 0 ? "done" : "pending")
      : ord > 2 ? "done" : ord === 2 ? "active" : "pending";
    steps.push({
      id: "server_restart",
      label: job.stage === "server_reconnecting" ? t("about.stepServerReconnecting") : t("about.stepServerRestart"),
      state: s2,
      meta: s2 === "active" ? elapsed : undefined,
      progressPct: s2 === "active" ? null : undefined,
    });
  }

  if (job.mode === "desktop" || job.mode === "both") {
    const s3: StepState = job.stage === "error"
      ? (job.bytesReceived > 0 || job.mode === "desktop" ? "error" : "pending")
      : ord > 3 ? "done" : ord === 3 ? "active" : "pending";
    const speed = job.bytesPerSec && job.bytesPerSec > 0 ? ` · ${formatBytes(job.bytesPerSec)}/s` : "";
    const dlMeta = job.stage === "desktop_verifying"
      ? t("about.stepVerifying")
      : job.totalBytes
        ? `${pct}% (${formatBytes(job.bytesReceived)} / ${formatBytes(job.totalBytes)}${speed})`
        : job.bytesReceived > 0
          ? `${formatBytes(job.bytesReceived)}${speed}`
          : s3 === "active" ? elapsed : undefined;
    steps.push({
      id: "desktop_download",
      label: t("about.stepDesktopDownload"),
      state: s3,
      meta: s3 === "active" ? dlMeta : undefined,
      progressPct: s3 === "active" ? pct : undefined,
    });

    const s4: StepState = ord > 4 ? "done" : ord === 4 ? "active" : "pending";
    steps.push({
      id: "desktop_install",
      label: t("about.stepDesktopInstall"),
      state: s4,
    });
  }

  return steps;
}

/** Multi-step live update progress card rendered inside Settings → About (survives closing Settings). */
export function UpdateTimeline({ job, now, onRetry }: { job: UpdateJob; now: number; onRetry: () => void }) {
  const steps = buildSteps(job, now);
  const active = job.stage !== "completed" && job.stage !== "error";

  return <div className="jv-upd-card" data-state={job.stage === "error" ? "error" : job.stage === "completed" ? "done" : "active"}>
    <div className="jv-upd-head">
      <strong className="jv-upd-title">
        {job.stage === "completed"
          ? t("about.progressDone", { version: job.targetVersion })
          : job.stage === "error"
            ? t("about.progressFailed")
            : t("about.progressRunning", { version: job.targetVersion })}
      </strong>
      {active && <span className="jv-upd-elapsed">{formatElapsed(job.startedAt, now)}</span>}
    </div>

    <ol className="jv-upd-steps">
      {steps.map(step => <li key={step.id} className="jv-upd-step" data-step={step.state}>
        <span className="jv-upd-icon" aria-hidden="true">
          {step.state === "active" ? <Loader2Icon className="jv-spin"/>
            : step.state === "done" ? <CheckCircle2Icon/>
            : step.state === "error" ? <AlertCircleIcon/>
            : <CircleIcon/>}
        </span>
        <div className="jv-upd-step-body">
          <div className="jv-upd-step-row">
            <span className="jv-upd-step-label">{step.label}</span>
            {step.meta && <span className="jv-upd-step-meta">{step.meta}</span>}
          </div>
          {step.detail && <p className="jv-upd-step-detail">{step.detail}</p>}
          {step.state === "active" && <div className="jv-upd-bar" role="progressbar"
            aria-valuenow={step.progressPct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <div className={step.progressPct === null || step.progressPct === undefined ? "jv-upd-bar-fill jv-upd-bar-indet" : "jv-upd-bar-fill"}
              style={step.progressPct !== null && step.progressPct !== undefined ? { width: `${step.progressPct}%` } : undefined}/>
          </div>}
        </div>
      </li>)}
    </ol>

    {active && <p className="jv-upd-hint">{t("about.progressBackgroundHint")}</p>}
    {job.error && <p className="jv-note-error" role="alert">{job.error}</p>}

    {(job.stage === "error" || job.stage === "completed") && <div className="jv-upd-actions">
      {job.stage === "error" && <Button type="button" size="sm" onClick={onRetry}>
        <RefreshCwIcon aria-hidden="true"/>{t("about.progressRetry")}
      </Button>}
      {job.stage === "completed" && <Button type="button" size="sm" onClick={() => updateStore.reloadPage()}>
        <RotateCwIcon aria-hidden="true"/>{t("about.progressReloadNow")}
      </Button>}
      <Button type="button" variant="outline" size="sm" onClick={() => updateStore.dismissJob()}>
        {t("common.close")}
      </Button>
    </div>}
  </div>;
}
