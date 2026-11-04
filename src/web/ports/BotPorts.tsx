import { useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type PortState, type PublishedPort } from "../../contract/ports";
import { t, type Key } from "../i18n";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import { useAction } from "../action";
import { copyText } from "../ui";
import "../styles/ports.css";

const HINT: Partial<Record<PortState, Key>> = { local: "ports.hint.local", idle: "ports.hint.idle", stopped: "ports.hint.stopped" };
/** How this browser reaches it: the host it reached Jarvy at, on the port's own port. The server's links follow for
 * other devices. */
function links(port: PublishedPort): string[] {
  const here = `${location.protocol}//${location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname}:${port.hostPort}`;
  return [here, ...port.urls.filter(url => url !== here)];
}

/** Bot info's port forwarding (A74): the ports the Bot published, which Jarvy forwards, listed like its scheduled tasks: each row says what the port is and how it is
 * doing and opens its link; touching the row opens its details, with every link and Unpublish. The Bot publishes
 * them with ports.publish; `runs` changes when it starts or ends a turn, when it may have, so the list reloads then. */
export function BotPorts({ bot, runs }: { bot: Bot; runs: string }) {
  const [ports, setPorts] = useState<PublishedPort[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    let alive = true;
    void api.ports(bot.id).then(result => { if (alive) setPorts(result.ports); }).catch(reason => { if (alive) setError(errorText(reason, "ports.loadFailed")); });
    return () => { alive = false; };
  }, [bot.id, runs]);
  const shown = open === null ? null : ports?.find(port => port.port === open) ?? null;
  function show(port: number | null) { setError(""); setConfirming(false); setOpen(port); }
  const unpublish = (port: PublishedPort) => run("unpublish", async () => {
    await api.unpublishPort(bot.id, port.port);
    setPorts(current => current?.filter(item => item.port !== port.port) ?? null);
    show(null);
  }, "ports.changeFailed");
  const state = (port: PublishedPort) => <span className="jv-port-state" data-state={port.state}>{t(`ports.state.${port.state}`)}</span>;

  return <section className="jv-section" aria-label={t("ports.title")}>
    <h3 className="jv-section-title">{t("ports.title")}</h3>
    {shown ? <div className="jv-list jv-port-details" role="group" aria-label={shown.name}>
      <div className="jv-list-row jv-static-row jv-port-head">
        <span className="jv-row-text"><strong>{shown.name}</strong><span>{shown.description}</span></span>
        <span className="jv-status" data-ok={shown.state === "live" || undefined} data-busy={shown.state === "local" || shown.state === "idle" || undefined}>{t(`ports.state.${shown.state}`)}</span>
      </div>
      {HINT[shown.state] && <div className="jv-list-row jv-static-row jv-port-hint" role="note">{t(HINT[shown.state]!)}</div>}
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("ports.sandboxPort")}</strong></span><code className="jv-port-value">{shown.port}</code>
      </div>
      {links(shown).map((url, index) => <div key={url} className="jv-list-row jv-static-row jv-port-link">
        <span className="jv-row-text"><strong>{t(index ? "ports.linkOther" : "ports.link")}</strong><code title={url}>{url}</code></span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(copied === url ? "ui.copied" : "ports.copy")} onClick={() => void copyText(url).then(ok => setCopied(ok ? url : null))}>
          {copied === url ? <CheckIcon/> : <CopyIcon/>}</Button>
        <Button asChild variant="ghost" size="icon-sm"><a href={url} target="_blank" rel="noopener noreferrer" aria-label={t("ports.open", { name: shown.name })}><ExternalLinkIcon/></a></Button>
      </div>)}
      {confirming ? <div className="jv-list-row jv-static-row jv-port-confirm" role="group" aria-label={t("ports.stopTitle", { name: shown.name })}>
        <span className="jv-row-text"><strong>{t("ports.stopTitle", { name: shown.name })}</strong><span>{t("ports.stopBody")}</span></span>
        <div className="jv-port-actions-end"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
          <Button type="button" variant="ghost" size="sm" className="jv-port-unpublish" disabled={busy} onClick={() => void unpublish(shown)}>{t("ports.stop")}</Button></div>
      </div>
        : <div className="jv-list-row jv-static-row jv-port-actions">
          <Button type="button" variant="ghost" size="sm" className="jv-port-unpublish" disabled={busy} onClick={() => setConfirming(true)}>{t("ports.stop")}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => show(null)}>{t("ports.back")}</Button>
        </div>}
    </div>
      : ports && <div className="jv-list">
        {ports.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("ports.empty")}</span></span></div>
          : ports.map(port => <div key={port.port} className="jv-port-row" data-state={port.state}>
            <button type="button" className="jv-list-row jv-port-open" aria-label={port.name} onClick={() => show(port.port)}>
              <span className="jv-row-text"><strong>{port.name}</strong><span className="jv-port-line">{t("ports.port", { port: port.port })} · {state(port)}</span></span>
              <ChevronRightIcon className="jv-row-chevron"/>
            </button>
            <Button asChild variant="ghost" size="icon-sm" className="jv-port-go"><a href={links(port)[0]} target="_blank" rel="noopener noreferrer" aria-label={t("ports.open", { name: port.name })}><ExternalLinkIcon/></a></Button>
          </div>)}
      </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
