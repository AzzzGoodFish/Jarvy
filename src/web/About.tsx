import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { license, name, repository, version } from "../../package.json";
import type { DesktopUpdateStatus } from "../contract/desktop";
import { compareSemver, type UpdateStatus } from "../contract/update";
import { api } from "./api";
import { desktop } from "./desktop";
import { errorText } from "./errors";
import { t } from "./i18n";
import { Button } from "./components/ui/button";

/** The package's own record (read at build time): the repository, and the files it ships at this version. */
const repo = repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), at = `${repo}/blob/v${version}`;
const LINKS = [
  { label: "about.source", detail: repo.replace(/^https:\/\//, ""), href: repo },
  { label: "about.package", detail: name, href: `https://www.npmjs.com/package/${name}` },
  { label: "about.license", detail: license, href: `${at}/LICENSE` },
  { label: "about.notices", detail: "THIRD_PARTY_NOTICE.md", href: `${at}/THIRD_PARTY_NOTICE.md` },
] as const;

/** Settings → About: server & desktop versions, unified update check, and one-click server + desktop restart (A113). */
export function About() {
  const client = desktop();
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [srv, desk] = await Promise.all([
      api.updateStatus().catch(() => null),
      client?.updateStatus ? client.updateStatus().catch(() => null) : Promise.resolve(null),
    ]);
    if (srv) setUpdate(srv);
    if (desk) setDesktopUpdate(desk);
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  // Even an older desktop client (without checkUpdate IPC) can detect mismatch against the server/latest version.
  const desktopCurrent = desktopUpdate?.currentVersion ?? client?.version ?? null;
  const knownLatest = desktopUpdate?.latestVersion
    ?? (update?.latestVersion && compareSemver(update.latestVersion, update.currentVersion) > 0 ? update.latestVersion : update?.currentVersion ?? version);
  const desktopNeedsUpdate = desktopUpdate
    ? desktopUpdate.updateAvailable
    : !!(desktopCurrent && knownLatest && compareSemver(knownLatest, desktopCurrent) > 0);
  const serverNeedsUpdate = Boolean(update?.updateAvailable);
  const canApplyServer = serverNeedsUpdate && update?.installMode === "npm";
  const canApplyDesktop = desktopNeedsUpdate && Boolean(client?.installUpdate);
  const anyUpdate = serverNeedsUpdate || desktopNeedsUpdate;
  const displayLatest = (desktopUpdate?.latestVersion && (!update?.latestVersion || compareSemver(desktopUpdate.latestVersion, update.latestVersion) >= 0))
    ? desktopUpdate.latestVersion
    : (update?.latestVersion ?? knownLatest);
  const releaseUrl = update?.releaseUrl ?? desktopUpdate?.releaseUrl ?? `${repo}/releases/latest`;

  const checkNow = async () => {
    setChecking(true); setError(null); setNotice(null);
    try {
      const [srv, desk] = await Promise.all([
        api.checkForUpdate(),
        client?.checkUpdate ? client.checkUpdate().catch(() => null) : Promise.resolve(null),
      ]);
      setUpdate(srv);
      if (desk) setDesktopUpdate(desk);
      const latest = desk?.latestVersion ?? srv.latestVersion ?? srv.currentVersion;
      const deskBehind = desk ? desk.updateAvailable : !!(client?.version && latest && compareSemver(latest, client.version) > 0);
      if (srv.lastError && !desk?.updateAvailable) setError(srv.lastError);
      else if (srv.updateAvailable || deskBehind) setNotice(t("about.updateFound", { version: latest }));
      else setNotice(t("about.upToDate"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setChecking(false);
    }
  };

  const pollReload = () => {
    const poll = window.setInterval(() => {
      void api.me().then(() => {
        window.clearInterval(poll);
        window.location.reload();
      }).catch(() => { /* still restarting */ });
    }, 2500);
    window.setTimeout(() => window.clearInterval(poll), 120_000);
  };

  const applyServerOnly = async () => {
    setApplying(true); setError(null); setNotice(null);
    try {
      const res = await api.applyUpdate();
      setNotice(res.started ? t("about.restarting", { version: res.targetVersion }) : t("about.upToDate"));
      if (res.started) pollReload();
      else setApplying(false);
    } catch (reason) {
      setError(errorText(reason));
      setApplying(false);
    }
  };

  const applyDesktopOnly = async () => {
    if (!client?.installUpdate) return;
    setApplying(true); setError(null); setNotice(null);
    try {
      const res = await client.installUpdate();
      if (!res.started) {
        setError(res.error || t("common.failed"));
        setApplying(false);
      } else {
        setNotice(t("about.desktopUpdating", { version: displayLatest }));
      }
    } catch (reason) {
      setError(errorText(reason));
      setApplying(false);
    }
  };

  const applyAll = async () => {
    setApplying(true); setError(null); setNotice(null);
    try {
      if (canApplyServer) {
        const srvRes = await api.applyUpdate();
        if (srvRes.started) setNotice(t("about.restartingAll", { version: srvRes.targetVersion }));
      }
      if (canApplyDesktop && client?.installUpdate) {
        const deskRes = await client.installUpdate();
        if (!deskRes.started) {
          setError(deskRes.error || t("common.failed"));
          if (canApplyServer) pollReload();
          else setApplying(false);
        } else if (!canApplyServer) {
          setNotice(t("about.desktopUpdating", { version: displayLatest }));
        }
      } else if (canApplyServer) {
        pollReload();
      }
    } catch (reason) {
      setError(errorText(reason));
      setApplying(false);
    }
  };

  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.about")}</h2></header>
    <div className="jv-list">
      <div className="jv-list-row jv-static-row jv-about-intro"><div className="jv-row-text"><strong>Jarvy</strong><span>{t("about.tagline")}</span></div>
        <span className="jv-row-meta">{t("about.version", { version })}</span></div>
      {LINKS.map(link => <a key={link.label} className="jv-list-row jv-link-row" href={link.href} target="_blank" rel="noreferrer">
        <div className="jv-row-text"><strong>{t(link.label)}</strong><span>{link.detail}</span></div><ExternalLinkIcon aria-hidden="true"/></a>)}
    </div>

    <section className="jv-section" aria-labelledby="about-updates">
      <h3 id="about-updates" className="jv-section-title">{t("about.updatesTitle")}</h3>
      <div className="jv-list">
        <div className="jv-list-row jv-static-row">
          <span className="jv-row-text">
            <strong>{anyUpdate ? t("about.updateFound", { version: displayLatest }) : t("about.upToDate")}</strong>
            <span>{update?.checkedAt ? t("about.lastChecked", { time: new Date(update.checkedAt).toLocaleString() }) : t("about.notCheckedYet")}</span>
          </span>
          <span className="jv-status" data-ok={!anyUpdate || undefined}>
            v{update?.currentVersion ?? version}
          </span>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("about.serverVersion")}</span>
          <code>v{update?.currentVersion ?? version}{serverNeedsUpdate && update?.latestVersion ? ` → v${update.latestVersion}` : ""}</code>
        </div>
        {desktopCurrent && <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("about.desktopVersion")}</span>
          <code>v{desktopCurrent}{desktopNeedsUpdate ? ` → v${displayLatest}` : ""}</code>
        </div>}
        <div className="jv-list-row jv-static-row jv-env-details">
          <div className="jv-sec-actions">
            <Button type="button" variant="outline" size="sm" disabled={checking || applying} onClick={() => void checkNow()}>
              <RefreshCwIcon className={checking ? "jv-spin" : undefined} aria-hidden="true"/>
              {t(checking ? "about.checking" : "about.checkUpdate")}
            </Button>
            {canApplyServer && canApplyDesktop && <Button type="button" size="sm" disabled={applying || checking} onClick={() => void applyAll()}>
              <DownloadIcon aria-hidden="true"/>
              {t(applying ? "about.updating" : "about.updateBoth")}
            </Button>}
            {canApplyServer && !canApplyDesktop && <Button type="button" size="sm" disabled={applying || checking} onClick={() => void applyServerOnly()}>
              <DownloadIcon aria-hidden="true"/>
              {t(applying ? "about.updating" : "about.updateAndRestart")}
            </Button>}
            {!canApplyServer && canApplyDesktop && <Button type="button" size="sm" disabled={applying || checking} onClick={() => void applyDesktopOnly()}>
              <DownloadIcon aria-hidden="true"/>
              {t(applying ? "about.updating" : "about.updateDesktop")}
            </Button>}
            {desktopNeedsUpdate && !canApplyDesktop && <a className="jv-hint" href={releaseUrl} target="_blank" rel="noreferrer">
              {t("about.downloadDesktop")}
            </a>}
            {anyUpdate && <a className="jv-hint" href={releaseUrl} target="_blank" rel="noreferrer">
              {t("about.viewRelease")}
            </a>}
          </div>
          {serverNeedsUpdate && update?.installMode === "git" && <p className="jv-hint">{t("about.gitCheckoutHint")}</p>}
          {notice && <p className="jv-hint" role="status">{notice}</p>}
          {error && <p className="jv-note-error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  </div>;
}
