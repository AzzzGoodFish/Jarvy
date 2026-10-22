import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { api, type ConnectionInfo } from "../api";
import { rich, t } from "../i18n";
import { Button } from "../components/ui/button";
import { copyText } from "../ui";
import "../styles/connection.css";

/** Settings → Network (A51): LAN access. When Jarvy listens beyond this machine, the HTTPS addresses other
 * devices open, Jarvy's certificate to install once on each, and whether plain HTTP from other machines is allowed;
 * otherwise how to open it to the network. */
export function NetworkSettings() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.connection().then(setInfo).catch(() => setFailed(true)); }, []);
  const page = (body: ReactNode) => <div className="jv-page">
    <header className="jv-page-header"><div><h2>{t("settings.network")}</h2></div></header>
    <section className="jv-section" aria-labelledby="network-lan"><h3 id="network-lan" className="jv-section-title">{t("connection.lan")}</h3>{body}</section>
    {failed && <p className="jv-note-error" role="alert">{t("common.failed")}</p>}
  </div>;
  if (!info) return page(null);
  if (!info.https) return page(<div className="jv-list"><div className="jv-list-row jv-static-row jv-conn-local">
    <span className="jv-row-text"><strong>{t("connection.localOnly")}</strong><span>{rich("connection.localOnlyHint", { flag: <code>--host 0.0.0.0</code> })}</span></span>
  </div></div>);
  const toggle = async () => {
    setBusy(true); setFailed(false);
    try { setInfo(await api.setConnection(!info.allowHttp)); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return page(<>
    <p className="jv-hint jv-conn-intro">{t("connection.lanHint")}</p>
    <div className="jv-list" role="group" aria-label={t("connection.addresses")}>
      {info.addresses.map(address => <div key={address} className="jv-list-row jv-static-row">
        <span className="jv-row-text"><code>{address}</code></span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(copied === address ? "ui.copied" : "connection.copy")} onClick={() => void copyText(address).then(ok => setCopied(ok ? address : null))}>
          {copied === address ? <CheckIcon/> : <CopyIcon/>}</Button>
      </div>)}
    </div>
    <div className="jv-list jv-conn-cert">
      <div className="jv-list-row jv-static-row jv-conn-root">
        <span className="jv-row-text"><strong>{t("connection.root")}</strong><span>{t("connection.rootHint")}</span></span>
        {/* A plain link: iOS offers to install a certificate it navigates to, and saves one marked for download. */}
        <Button asChild variant="outline" size="sm"><a href="/api/connection/root.crt"><DownloadIcon/>{t("connection.download")}</a></Button>
      </div>
      {/* Both fingerprints in one grid, so their values line up; lines break between the pairs only. */}
      <div className="jv-list-row jv-static-row jv-conn-print">
        <span>{t("connection.fingerprint")}</span><code>{info.fingerprint?.replaceAll(":", ":\u200b")}</code>
        {info.fingerprintSha1 && <><span>{t("connection.fingerprintSha1")}</span><code>{info.fingerprintSha1.replaceAll(":", ":\u200b")}</code></>}
      </div>
      <button type="button" className="jv-list-row jv-conn-disclosure" aria-expanded={steps} onClick={() => setSteps(!steps)}>
        <span className="jv-row-text"><strong>{t("connection.howTo")}</strong></span><ChevronDownIcon aria-hidden="true"/>
      </button>
      {steps && <div className="jv-list-row jv-static-row jv-conn-steps"><ul>
        <li>{t("connection.howMac")}</li><li>{t("connection.howWindows")}</li><li>{t("connection.howIos")}</li><li>{t("connection.howAndroid")}</li><li>{t("connection.howRestart")}</li>
      </ul></div>}
    </div>
    <div className="jv-list">
      <button type="button" role="switch" aria-checked={info.allowHttp} disabled={busy} className="jv-list-row jv-choice-row jv-conn-http" onClick={() => void toggle()}>
        <span className="jv-row-text"><strong>{t("connection.allowHttp")}</strong><span>{t("connection.allowHttpHint")}</span></span>
        <span className="jv-conn-switch" aria-hidden="true"/>
      </button>
    </div>
  </>);
}
