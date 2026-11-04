import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { api } from "../api";
import { type ConnectionInfo } from "../../contract/connection";
import { rich, t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorText } from "../errors";
import { copyText } from "../ui";
import "../styles/connection.css";

/** The range of Jarvy's ports it forwards published ones from (A74), saved as a pair. */
function PortRangeSection({ info, onSaved }: { info: ConnectionInfo; onSaved: (info: ConnectionInfo) => void }) {
  const [from, setFrom] = useState(String(info.ports.from)), [to, setTo] = useState(String(info.ports.to));
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null), [busy, setBusy] = useState(false);
  const dirty = from !== String(info.ports.from) || to !== String(info.ports.to);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setNote(null);
    try { const next = await api.setPortRange({ from: Number(from), to: Number(to) }); onSaved(next); setFrom(String(next.ports.from)); setTo(String(next.ports.to)); setNote({ error: false, text: t("ports.rangeSaved") }); }
    catch (reason) { setNote({ error: true, text: errorText(reason) }); } finally { setBusy(false); }
  };
  return <section className="jv-section" aria-labelledby="network-ports"><h3 id="network-ports" className="jv-section-title">{t("ports.range")}</h3>
    <form className="jv-panel jv-conn-ports" onSubmit={event => void save(event)}>
      <div className="jv-conn-range">
        <label className="jv-field"><span>{t("ports.rangeFrom")}</span><Input type="number" inputMode="numeric" min={1024} max={65535} required value={from} onChange={event => { setFrom(event.target.value); setNote(null); }}/></label>
        <label className="jv-field"><span>{t("ports.rangeTo")}</span><Input type="number" inputMode="numeric" min={1024} max={65535} required value={to} onChange={event => { setTo(event.target.value); setNote(null); }}/></label>
      </div>
      <small className="jv-hint">{t("ports.rangeHint")}</small>
      <div className="jv-form-footer">{note ? <p className={note.error ? "jv-note-error" : "jv-hint"} role={note.error ? "alert" : "status"}>{note.text}</p> : <span/>}
        <Button type="submit" className="jv-primary" disabled={busy || !dirty}>{t("common.save")}</Button></div>
    </form>
  </section>;
}

/** Settings → Network (A51): LAN access. When Jarvy listens beyond this machine, the HTTPS addresses other
 * devices open, Jarvy's certificate to install once on each, and whether plain HTTP from other machines is allowed;
 * otherwise how to open it to the network. Then the ports it forwards Bots' published ports from (A74). */
export function NetworkSettings() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.connection().then(setInfo).catch(() => setFailed(true)); }, []);
  const page = (body: ReactNode) => <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.network")}</h2></header>
    <section className="jv-section" aria-labelledby="network-lan"><h3 id="network-lan" className="jv-section-title">{t("connection.lan")}</h3>{body}</section>
    {failed && <p className="jv-note-error" role="alert">{t("common.failed")}</p>}
    {info && <PortRangeSection info={info} onSaved={setInfo}/>}
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
    <div className="jv-list" role="group" aria-label={t("connection.addresses")}>
      {info.addresses.map(address => <div key={address} className="jv-list-row jv-static-row">
        <span className="jv-row-text"><code>{address}</code></span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(copied === address ? "ui.copied" : "connection.copy")} onClick={() => void copyText(address).then(ok => setCopied(ok ? address : null))}>
          {copied === address ? <CheckIcon/> : <CopyIcon/>}</Button>
      </div>)}
    </div>
    <div className="jv-list jv-conn-cert">
      <div className="jv-list-row jv-static-row jv-conn-root">
        <span className="jv-row-text"><strong>{t("connection.root")}</strong></span>
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
