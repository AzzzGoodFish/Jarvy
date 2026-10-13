import { useState } from "react";
import { DatabaseIcon, InfoIcon } from "lucide-react";
import type { ModelConnection } from "./api";
import { About } from "./About";
import { ModelSettings } from "./ModelSettings";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import "./styles/model-workbench.css";

const TABS = [{ id: "models", label: "模型", icon: DatabaseIcon }, { id: "about", label: "关于", icon: InfoIcon }] as const;
export function SettingsDialog({ connections, onChanged, onClose, initialTab = "models" }: {
  connections: ModelConnection[]; onChanged: () => Promise<void>; onClose: () => void; initialTab?: "models" | "about";
}) {
  const [tab, setTab] = useState(initialTab);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="jv-settings-shell" aria-describedby={undefined}>
    <nav className="jv-settings-nav" aria-label="设置分类">
      <DialogTitle className="jv-settings-title">设置</DialogTitle>
      {TABS.map(item => <button type="button" key={item.id} className="jv-nav-item" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><item.icon/>{item.label}</button>)}
    </nav>
    <main className="jv-settings-content">{tab === "models" ? <ModelSettings connections={connections} onChanged={onChanged}/> : <About/>}</main>
  </DialogContent></Dialog>;
}
