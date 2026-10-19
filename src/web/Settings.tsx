import { useState } from "react";
import { DatabaseIcon, GlobeIcon, InfoIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ModelConnection } from "./api";
import { About } from "./About";
import { General } from "./General";
import { ModelSettings } from "./ModelSettings";
import { NetworkSettings } from "./connection/NetworkSettings";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { t } from "./i18n";
import "./styles/model-workbench.css";

export type SettingsTab = "general" | "models" | "network" | "about";
const TABS = [{ id: "general", label: "settings.general", icon: SlidersHorizontalIcon }, { id: "models", label: "settings.models", icon: DatabaseIcon },
  { id: "network", label: "settings.network", icon: GlobeIcon }, { id: "about", label: "settings.about", icon: InfoIcon }] as const;
export function SettingsDialog({ connections, onChanged, onClose, initialTab = "general" }: {
  connections: ModelConnection[]; onChanged: () => Promise<void>; onClose: () => void; initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="jv-settings-shell" aria-describedby={undefined}>
    <nav className="jv-settings-nav" aria-label={t("settings.sections")}>
      <DialogTitle className="jv-settings-title">{t("settings.title")}</DialogTitle>
      {TABS.map(item => <button type="button" key={item.id} className="jv-nav-item" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><item.icon/>{t(item.label)}</button>)}
    </nav>
    <main className="jv-settings-content">{tab === "general" ? <General/> : tab === "models" ? <ModelSettings connections={connections} onChanged={onChanged}/> : tab === "network" ? <NetworkSettings/> : <About/>}</main>
  </DialogContent></Dialog>;
}
