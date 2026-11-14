import { useEffect, useRef, useState } from "react";
import { ChartColumnIcon, DatabaseIcon, GlobeIcon, InfoIcon, KeyRoundIcon, PlugIcon, SlidersHorizontalIcon } from "lucide-react";
import type { Bot } from "../contract/bots";
import type { ModelConnection } from "../contract/models";
import { About } from "./About";
import { General } from "./General";
import { ModelSettings } from "./ModelSettings";
import { NetworkSettings } from "./connection/NetworkSettings";
import { SecretSettings } from "./secrets/SecretSettings";
import { ConnectorSettings } from "./connectors/ConnectorSettings";
import { AllUsage } from "./usage/AllUsage";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { t } from "./i18n";
import "./styles/model-workbench.css";

/** Settings' pages. The machines added over SSH have the Environments page (A89). */
export type SettingsTab = "general" | "models" | "usage" | "secrets" | "connectors" | "network" | "about";
const TABS = [{ id: "general", label: "settings.general", icon: SlidersHorizontalIcon }, { id: "models", label: "settings.models", icon: DatabaseIcon },
  { id: "usage", label: "settings.usage", icon: ChartColumnIcon }, { id: "secrets", label: "settings.secrets", icon: KeyRoundIcon },
  { id: "connectors", label: "settings.connectors", icon: PlugIcon }, { id: "network", label: "settings.network", icon: GlobeIcon }, { id: "about", label: "settings.about", icon: InfoIcon }] as const;
export function SettingsDialog({ connections, bots, onChanged, onClose, initialTab = "general" }: {
  connections: ModelConnection[]; bots: Bot[]; onChanged: () => Promise<void>; onClose: () => void; initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // On a phone the tabs are one row that scrolls: keep the open one in view, such as Network opened from elsewhere.
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => { current.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [tab]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="jv-settings-shell" aria-describedby={undefined}>
    <nav className="jv-settings-nav" aria-label={t("settings.sections")}>
      <DialogTitle className="jv-settings-title">{t("settings.title")}</DialogTitle>
      <div className="jv-settings-tabs">{TABS.map(item => <button type="button" key={item.id} ref={tab === item.id ? current : undefined} className="jv-nav-item"
        aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><item.icon/>{t(item.label)}</button>)}</div>
    </nav>
    <main className="jv-settings-content">{tab === "general" ? <General/> : tab === "models" ? <ModelSettings connections={connections} onChanged={onChanged}/> : tab === "usage" ? <AllUsage bots={bots}/> : tab === "secrets" ? <SecretSettings/> : tab === "connectors" ? <ConnectorSettings/> : tab === "network" ? <NetworkSettings/> : <About/>}</main>
  </DialogContent></Dialog>;
}
