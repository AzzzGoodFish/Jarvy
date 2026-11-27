import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { api } from "./api";
import type { CloudStorageStatus } from "../contract/cloud";
import { errorText } from "./errors";
import { t } from "./i18n";
import { Button } from "./components/ui/button";
import "./styles/environment.css";

/** Settings → Storage (A107, A109): encrypted S3 cloud sync status, active fencing lease epoch,
 * DB snapshot revision, last sync time, error state, and one-click manual sync trigger. */
export function StorageSettings() {
  const [status, setStatus] = useState<CloudStorageStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.cloudStatus());
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api.cloudSync();
      setStatus(res.status);
      setNotice(t(res.changed ? "storage.syncedChanged" : "storage.syncedUpToDate"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSyncing(false);
    }
  };

  const uri = status?.bucket ? `s3://${status.bucket}${status.prefix ? `/${status.prefix}` : ""}` : "";

  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.storage")}</h2></header>
    <section className="jv-section" aria-labelledby="storage-cloud">
      <h3 id="storage-cloud" className="jv-section-title">{t("storage.cloudSection")}</h3>
      {status && !status.enabled && <div className="jv-list">
        <div className="jv-list-row jv-static-row">
          <span className="jv-row-text">
            <strong>{t("storage.localOnly")}</strong>
            <span>{t("storage.localOnlyHint")}</span>
          </span>
          <span className="jv-status">{t("storage.stateLocal")}</span>
        </div>
        <div className="jv-list-row jv-static-row jv-env-details">
          <p>{t("storage.enableCommandHint")}</p>
          <code className="jv-storage-cmd">jarvy server start --storage s3://&lt;bucket&gt; --storage-endpoint &lt;url&gt;</code>
        </div>
      </div>}

      {status?.enabled && <div className="jv-list jv-env-sandbox">
        <div className="jv-list-row jv-static-row">
          <span className="jv-row-text">
            <strong>{t("storage.cloudEnabled")}</strong>
            <span>{t("storage.encryptedHint")}</span>
          </span>
          <span className="jv-status" data-ok={!status.lastError || undefined}>
            {t(status.lastError ? "storage.stateError" : "storage.stateActive")}
          </span>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("storage.bucket")}</span>
          <code>{uri}</code>
        </div>
        {status.endpoint && <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("storage.endpoint")}</span>
          <code>{status.endpoint}</code>
        </div>}
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("storage.leaseEpoch")}</span>
          <code>#{status.epoch ?? 0}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("storage.dbRev")}</span>
          <code>r{status.dbRev ?? 0}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("storage.lastSynced")}</span>
          <span className="jv-env-value">
            {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : t("storage.never")}
          </span>
        </div>
        <div className="jv-list-row jv-static-row jv-env-details">
          {status.lastError && <p className="jv-note-error" role="alert">{status.lastError}</p>}
          <div className="jv-storage-actions">
            <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={() => void syncNow()}>
              <RefreshCwIcon className={syncing ? "jv-spin" : undefined} aria-hidden="true"/>
              {t(syncing ? "storage.syncing" : "storage.syncNow")}
            </Button>
            {notice && <span className="jv-hint" role="status">{notice}</span>}
          </div>
        </div>
      </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </section>
  </div>;
}
