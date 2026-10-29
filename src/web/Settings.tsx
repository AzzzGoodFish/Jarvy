import { useState } from "react";
import { DatabaseIcon, GlobeIcon, InfoIcon, KeyRoundIcon, ServerIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ModelConnection } from "../contract/models";
import { About } from "./About";
import { General } from "./General";
import { ModelSettings } from "./ModelSettings";
import { NetworkSettings } from "./connection/NetworkSettings";
import { SecretSettings } from "./secrets/SecretSettings";
import { MachineSettings } from "./environment/MachineSettings";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { t } from "./i18n";
import "./styles/model-workbench.css";

export type SettingsTab = "general" | "models" | "machines" | "secrets" | "network" | "about";
/** What opens Settings: a page, or the machines page with the form to add one (from Bot info, A67). */
export type SettingsOpen = SettingsTab | "addMachine";
const TABS = [{ id: "general", label: "settings.general", icon: SlidersHorizontalIcon }, { id: "models", label: "settings.models", icon: DatabaseIcon },
  { id: "machines", label: "settings.machines", icon: ServerIcon }, { id: "secrets", label: "settings.secrets", icon: KeyRoundIcon }, { id: "network", label: "settings.network", icon: GlobeIcon }, { id: "about", label: "settings.about", icon: InfoIcon }] as const;
export function SettingsDialog({ connections, onChanged, onClose, initialTab = "general" }: {
  connections: ModelConnection[]; onChanged: () => Promise<void>; onClose: () => void; initialTab?: SettingsOpen;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab === "addMachine" ? "machines" : initialTab);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="jv-settings-shell" aria-describedby={undefined}>
    <nav className="jv-settings-nav" aria-label={t("settings.sections")}>
      <DialogTitle className="jv-settings-title">{t("settings.title")}</DialogTitle>
      {TABS.map(item => <button type="button" key={item.id} className="jv-nav-item" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><item.icon/>{t(item.label)}</button>)}
    </nav>
    <main className="jv-settings-content">{tab === "general" ? <General/> : tab === "models" ? <ModelSettings connections={connections} onChanged={onChanged}/> : tab === "machines" ? <MachineSettings adding={initialTab === "addMachine"}/> : tab === "secrets" ? <SecretSettings/> : tab === "network" ? <NetworkSettings/> : <About/>}</main>
  </DialogContent></Dialog>;
}
