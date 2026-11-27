import { useEffect } from "react";
import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { license, name, repository, version } from "../../package.json";
import { compareSemver } from "../contract/update";
import { desktop } from "./desktop";
import { t } from "./i18n";
import { Button } from "./components/ui/button";
import { updateStore, useUpdateStore } from "./update/update-store";
import { UpdateTimeline } from "./update/UpdateTimeline";
import "./styles/update.css";

/** The package's own record (read at build time): the repository, and the files it ships at this version. */
const repo = repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), at = `${repo}/blob/v${version}`;
const LINKS = [
  { label: "about.source", detail: repo.replace(/^https:\/\//, ""), href: repo },
  { label: "about.package", detail: name, href: `https://www.npmjs.com/package/${name}` },
  { label: "about.license", detail: license, href: `${at}/LICENSE` },
  { label: "about.notices", detail: "THIRD_PARTY_NOTICE.md", href: `${at}/THIRD_PARTY_NOTICE.md` },
] as const;

/** Settings → About: server & desktop versions, unified update check, and persistent live update progress (A113). */
export function About() {
  const client = desktop();
  const { server: update, desktop: desktopUpdate, checking, error, job, now } = useUpdateStore();

  useEffect(() => {
    updateStore.init();
    void updateStore.refresh();
  }, []);

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
  const busy = checking || Boolean(job && job.stage !== "completed" && job.stage !== "error");

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
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void updateStore.checkNow()}>
              <RefreshCwIcon className={checking ? "jv-spin" : undefined} aria-hidden="true"/>
              {t(checking ? "about.checking" : "about.checkUpdate")}
            </Button>
            {canApplyServer && canApplyDesktop && <Button type="button" size="sm" disabled={busy} onClick={() => void updateStore.startUpdate("both", displayLatest)}>
              <DownloadIcon aria-hidden="true"/>
              {t(busy && !checking ? "about.updating" : "about.updateBoth")}
            </Button>}
            {canApplyServer && !canApplyDesktop && <Button type="button" size="sm" disabled={busy} onClick={() => void updateStore.startUpdate("server", update?.latestVersion ?? displayLatest)}>
              <DownloadIcon aria-hidden="true"/>
              {t(busy && !checking ? "about.updating" : "about.updateAndRestart")}
            </Button>}
            {!canApplyServer && canApplyDesktop && <Button type="button" size="sm" disabled={busy} onClick={() => void updateStore.startUpdate("desktop", displayLatest)}>
              <DownloadIcon aria-hidden="true"/>
              {t(busy && !checking ? "about.updating" : "about.updateDesktop")}
            </Button>}
            {desktopNeedsUpdate && !canApplyDesktop && <a className="jv-hint" href={releaseUrl} target="_blank" rel="noreferrer">
              {t("about.downloadDesktop")}
            </a>}
            {anyUpdate && <a className="jv-hint" href={releaseUrl} target="_blank" rel="noreferrer">
              {t("about.viewRelease")}
            </a>}
          </div>
          {serverNeedsUpdate && update?.installMode === "git" && <p className="jv-hint">{t("about.gitCheckoutHint")}</p>}
          {error && <p className="jv-note-error" role="alert">{error}</p>}
        </div>
        {job && <UpdateTimeline job={job} now={now} onRetry={() => void updateStore.startUpdate(job.mode, job.targetVersion)}/>}
      </div>
    </section>
  </div>;
}
