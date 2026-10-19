import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { api, type ConnectionInfo } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { copyText } from "../ui";
import "../styles/connection.css";

/** Settings → General → LAN access (A51): the HTTPS addresses other devices open, Jarvy's certificate to install once
 * on each, and whether plain HTTP from other machines is allowed. Shown only when Jarvy listens beyond this machine. */
export function LanAccess() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.connection().then(setInfo).catch(() => setInfo(null)); }, []);
  if (!info?.https) return null;
  const toggle = async () => {
    setBusy(true); setFailed(false);
    try { setInfo(await api.setConnection(!info.allowHttp)); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <section className="jv-section" aria-labelledby="general-lan"><h3 id="general-lan" className="jv-section-title">{t("connection.lan")}</h3>
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
      <div className="jv-list-row jv-static-row jv-conn-print"><span>{t("connection.fingerprint")}</span><code>{/* Lines break between the pairs only. */info.fingerprint?.replaceAll(":", ":\u200b")}</code></div>
      <button type="button" className="jv-list-row jv-conn-disclosure" aria-expanded={steps} onClick={() => setSteps(!steps)}>
        <span className="jv-row-text"><strong>{t("connection.howTo")}</strong></span><ChevronDownIcon aria-hidden="true"/>
      </button>
      {steps && <div className="jv-list-row jv-static-row jv-conn-steps"><ul>
        <li>{t("connection.howMac")}</li><li>{t("connection.howWindows")}</li><li>{t("connection.howIos")}</li><li>{t("connection.howAndroid")}</li>
      </ul></div>}
    </div>
    <div className="jv-list">
      <button type="button" role="switch" aria-checked={info.allowHttp} disabled={busy} className="jv-list-row jv-choice-row jv-conn-http" onClick={() => void toggle()}>
        <span className="jv-row-text"><strong>{t("connection.allowHttp")}</strong><span>{t("connection.allowHttpHint")}</span></span>
        <span className="jv-conn-switch" aria-hidden="true"/>
      </button>
    </div>
    {failed && <p className="jv-note-error" role="alert">{t("common.failed")}</p>}
  </section>;
}
