import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { license, name, repository, version } from "../../package.json";
import type { UpdateStatus } from "../contract/update";
import { api } from "./api";
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

/** Settings → About: version info, server update check & safe one-click restart (A113), and project links. */
export function About() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setUpdate(await api.updateStatus()); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const checkNow = async () => {
    setChecking(true); setError(null); setNotice(null);
    try {
      const next = await api.checkForUpdate();
      setUpdate(next);
      if (next.lastError) setError(next.lastError);
      else setNotice(next.updateAvailable && next.latestVersion ? t("about.updateFound", { version: next.latestVersion }) : t("about.upToDate"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setChecking(false);
    }
  };

  const applyNow = async () => {
    setApplying(true); setError(null); setNotice(null);
    try {
      const res = await api.applyUpdate();
      setNotice(res.started ? t("about.restarting", { version: res.targetVersion }) : t("about.upToDate"));
      if (res.started) {
        // Poll until the restarted server answers `/api/me`, then reload to pick up new assets.
        const poll = window.setInterval(() => {
          void api.me().then(() => {
            window.clearInterval(poll);
            window.location.reload();
          }).catch(() => { /* still restarting */ });
        }, 2500);
        window.setTimeout(() => window.clearInterval(poll), 120_000);
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
            <strong>{update?.updateAvailable && update.latestVersion ? t("about.updateFound", { version: update.latestVersion }) : t("about.upToDate")}</strong>
            <span>{update?.checkedAt ? t("about.lastChecked", { time: new Date(update.checkedAt).toLocaleString() }) : t("about.notCheckedYet")}</span>
          </span>
          <span className="jv-status" data-ok={!update?.updateAvailable || undefined}>
            v{update?.currentVersion ?? version}
          </span>
        </div>
        <div className="jv-list-row jv-static-row jv-env-details">
          <div className="jv-sec-actions">
            <Button type="button" variant="outline" size="sm" disabled={checking || applying} onClick={() => void checkNow()}>
              <RefreshCwIcon className={checking ? "jv-spin" : undefined} aria-hidden="true"/>
              {t(checking ? "about.checking" : "about.checkUpdate")}
            </Button>
            {update?.updateAvailable && update.installMode === "npm" && <Button type="button" size="sm" disabled={applying || checking} onClick={() => void applyNow()}>
              <DownloadIcon aria-hidden="true"/>
              {t(applying ? "about.updating" : "about.updateAndRestart")}
            </Button>}
            {update?.updateAvailable && update.releaseUrl && <a className="jv-hint" href={update.releaseUrl} target="_blank" rel="noreferrer">
              {t("about.viewRelease")}
            </a>}
          </div>
          {update?.updateAvailable && update.installMode === "git" && <p className="jv-hint">{t("about.gitCheckoutHint")}</p>}
          {notice && <p className="jv-hint" role="status">{notice}</p>}
          {error && <p className="jv-note-error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  </div>;
}
