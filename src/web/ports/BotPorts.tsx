import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type PortState, type PublishedPort } from "../../contract/ports";
import { t, type Key } from "../i18n";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import { useAction } from "../action";
import { copyText } from "../ui";
import { SettingsItem } from "../secrets/SettingsItem";
import "../styles/secrets.css";
import "../styles/ports.css";

const HINT: Partial<Record<PortState, Key>> = { local: "ports.hint.local", idle: "ports.hint.idle", stopped: "ports.hint.stopped" };
/** How this browser reaches it: the host it reached Jarvy at, on the port's own port. The server's links follow for
 * other devices. */
function links(port: PublishedPort): string[] {
  const here = `${location.protocol}//${location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname}:${port.hostPort}`;
  return [here, ...port.urls.filter(url => url !== here)];
}

/** A Bot's port forwarding (A74), in Bot info and on the Environments page: the ports it published, which Jarvy
 * forwards, as rows that open in place like Settings' secrets. A row says what the port is, Jarvy's port for it (the
 * one in its link, on the owner's machine) and how it is doing, and opens its link; open, the description, what to do
 * when it can't be reached, every link, the sandbox's port it comes from, and Stop forwarding, asked in place. The Bot
 * publishes them with ports.publish; `runs` changes when it starts or ends a turn, when it may have, so the list
 * reloads then. */
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
  function toggle(port: number) { setError(""); setConfirming(false); setOpen(current => current === port ? null : port); }
  const unpublish = (port: PublishedPort) => run("unpublish", async () => {
    await api.unpublishPort(bot.id, port.port);
    setPorts(current => current?.filter(item => item.port !== port.port) ?? null);
    setOpen(null); setConfirming(false);
  }, "ports.changeFailed");
  const opened = open !== null && !!ports?.some(port => port.port === open);

  return <section className="jv-section" aria-label={t("ports.title")}>
    <h3 className="jv-section-title">{t("ports.title")}</h3>
    {ports && <div className="jv-list">
      {ports.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("ports.empty")}</span></span></div>
        : ports.map(port => {
          const urls = links(port), shown = open === port.port;
          return <SettingsItem key={port.port} id={`port-${bot.id}-${port.port}`} open={shown} onToggle={() => toggle(port.port)} busy={busy} error={shown ? error : ""}
            text={<><strong>{port.name}</strong><span className="jv-port-line">{t("ports.port", { port: port.hostPort })} · <span className="jv-port-state" data-state={port.state}>{t(`ports.state.${port.state}`)}</span></span></>}
            meta={null}
            extra={<Button asChild variant="ghost" size="icon-sm"><a href={urls[0]} target="_blank" rel="noopener noreferrer" aria-label={t("ports.open", { name: port.name })}><ExternalLinkIcon/></a></Button>}
            remove={t("ports.stop")} confirming={shown && confirming ? { title: t("ports.stopTitle", { name: port.name }), body: t("ports.stopBody"), confirm: t("ports.stop") } : null}
            onAskRemove={() => setConfirming(true)} onCancel={() => setConfirming(false)} onConfirm={() => void unpublish(port)}>
            {port.description && <p className="jv-port-about">{port.description}</p>}
            {HINT[port.state] && <p className="jv-port-hint" role="note">{t(HINT[port.state]!)}</p>}
            <div className="jv-port-links">{urls.map((url, index) => <div key={url} className="jv-port-link">
              <span>{t(index ? "ports.linkOther" : "ports.link")}</span><code title={url}>{url}</code>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t(copied === url ? "ui.copied" : "ports.copy")} onClick={() => void copyText(url).then(ok => setCopied(ok ? url : null))}>
                {copied === url ? <CheckIcon/> : <CopyIcon/>}</Button>
              <Button asChild variant="ghost" size="icon-sm"><a href={url} target="_blank" rel="noopener noreferrer" aria-label={t("ports.open", { name: port.name })}><ExternalLinkIcon/></a></Button>
            </div>)}</div>
            <p className="jv-port-from">{t("ports.from", { port: port.port })}</p>
          </SettingsItem>;
        })}
    </div>}
    {error && !opened && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
