import { useEffect } from "react";
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, XIcon } from "lucide-react";
import { t } from "../i18n";
import { updateStore, useUpdateStore, type UpdateJob } from "./update-store";
import { formatElapsed } from "./UpdateTimeline";
import "../styles/update.css";

function pillLabel(job: UpdateJob, now: number): string {
  switch (job.stage) {
    case "server_installing":
      return t("about.pillServerInstalling", { version: job.targetVersion, elapsed: formatElapsed(job.startedAt, now) });
    case "server_restarting":
      return t("about.pillServerRestarting");
    case "server_reconnecting":
      return t("about.pillServerReconnecting");
    case "desktop_downloading": {
      const pct = job.totalBytes && job.totalBytes > 0 ? Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100)) : null;
      return pct !== null
        ? t("about.pillDesktopDownloadingPct", { pct: String(pct) })
        : t("about.pillDesktopDownloading");
    }
    case "desktop_verifying":
      return t("about.stepVerifying");
    case "desktop_installing":
      return t("about.stepDesktopInstall");
    case "completed":
      return t("about.progressDone", { version: job.targetVersion });
    case "error":
      return t("about.progressFailed");
  }
}

/** Persistent non-blocking corner status capsule that stays visible after closing Settings → About. */
export function UpdatePill({ hidden, onOpenAbout }: { hidden: boolean; onOpenAbout: () => void }) {
  const { job, now } = useUpdateStore();

  useEffect(() => { updateStore.init(); }, []);

  if (!job || job.dismissed || hidden) return null;

  const active = job.stage !== "completed" && job.stage !== "error";
  const pct = job.stage === "desktop_downloading" && job.totalBytes && job.totalBytes > 0
    ? Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100))
    : null;

  return <div className="jv-upd-pill" role="status" aria-live="polite"
    data-state={job.stage === "error" ? "error" : job.stage === "completed" ? "done" : "active"}>
    <button type="button" className="jv-upd-pill-main" onClick={onOpenAbout}>
      <span className="jv-upd-pill-icon" aria-hidden="true">
        {active ? <Loader2Icon className="jv-spin"/>
          : job.stage === "completed" ? <CheckCircle2Icon/>
          : <AlertCircleIcon/>}
      </span>
      <span className="jv-upd-pill-text">{pillLabel(job, now)}</span>
    </button>
    {!active && <button type="button" className="jv-upd-pill-close" aria-label={t("common.close")} onClick={() => updateStore.dismissJob()}>
      <XIcon aria-hidden="true"/>
    </button>}
    {active && <div className="jv-upd-pill-track" aria-hidden="true">
      <div className={pct === null ? "jv-upd-bar-fill jv-upd-bar-indet" : "jv-upd-bar-fill"}
        style={pct !== null ? { width: `${pct}%` } : undefined}/>
    </div>}
  </div>;
}
