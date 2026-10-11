import { useState } from "react";
import { DatabaseIcon, InfoIcon } from "lucide-react";
import type { ModelConnection } from "./api";
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
    <main className="jv-settings-content">{tab === "models" ? <ModelSettings connections={connections} onChanged={onChanged}/> : <div className="jv-page">
      <header className="jv-page-header"><div><h2>关于</h2></div></header>
      <div className="jv-list"><div className="jv-list-row jv-static-row"><div className="jv-row-text"><strong>Jarvy</strong><span>本地 Bot 私聊</span></div><span className="jv-row-meta">版本 0.1.0</span></div></div>
    </div>}</main>
  </DialogContent></Dialog>;
}
