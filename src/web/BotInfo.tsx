import { BotActivity } from "./activity/BotActivity";
import "./styles/history.css";
import { useEffect, useState, type FormEvent } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, HashIcon, HistoryIcon, MessagesSquareIcon } from "lucide-react";
import { api, type Bot, type BotStatus, type Chat, type ModelConnection } from "./api";
import { BotAvatar } from "./avatar/BotAvatar";
import { BOT_COLORS, colorHex, type BotColor } from "./avatar/palette";
import { BotModelControls } from "./BotModelControls";
import { copyText } from "./ui";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

type Note = { kind: "error" | "ok"; text: string } | null;
const STATUS_LABEL = { running: "运行中", idle: "空闲", stop: "已停止" } as const;

export function BotInfo({ bot, status, connections, chats, onSaved, onManageModels, onClose, onOpenChat, onOpenSubscription }: {
  onOpenChat: (id: string) => void; onOpenSubscription: (chat: Chat) => void; chats: Chat[]; bot: Bot; status?: BotStatus; connections: ModelConnection[]; onSaved: (bot: Bot) => void; onManageModels: () => void; onClose: () => void;
}) {
  const [section, setSection] = useState<"info" | "activity">("info");
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [systemPrompt, setSystemPrompt] = useState(bot.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [profileNote, setProfileNote] = useState<Note>(null);
  const [colorNote, setColorNote] = useState<Note>(null);
  const [control, setControl] = useState<"start" | "stop" | "abort" | null>(null);
  const [controlError, setControlError] = useState("");
  const [copied, setCopied] = useState(false);
  // What the Bot subscribed to is the Bot's own business, so it shows here.
  const [subscriptions, setSubscriptions] = useState<Chat[] | null>(null);
  useEffect(() => { let alive = true; void api.botSubscriptions(bot.id).then(result => { if (alive) setSubscriptions(result.chats); }).catch(() => {}); return () => { alive = false; }; }, [bot.id]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  const dirty = name !== bot.name || description !== bot.description || systemPrompt !== bot.systemPrompt;
  const runtime = status?.status ?? "stop";
  const context = status?.context;
  async function controlRuntime(action: "start" | "stop" | "abort") {
    setControl(action); setControlError("");
    try { await api.controlBot(bot.id, action); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setControl(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setProfileNote(null);
    try { onSaved(await api.saveBot(bot.id, { name, description, systemPrompt })); setProfileNote({ kind: "ok", text: "已保存" }); }
    catch (reason) { setProfileNote({ kind: "error", text: reason instanceof Error ? reason.message : "保存失败" }); }
    finally { setBusy(false); }
  }
  async function changeColor(color: BotColor) {
    if (color === bot.color) return;
    setBusy(true); setColorNote(null);
    try { onSaved(await api.setBotColor(bot.id, color)); }
    catch (reason) { setColorNote({ kind: "error", text: reason instanceof Error ? reason.message : "修改失败" }); }
    finally { setBusy(false); }
  }
  const note = (value: Note) => value && <p className={value.kind === "error" ? "jv-note-error" : "jv-note-ok"} role={value.kind === "error" ? "alert" : "status"}>{value.text}</p>;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={`jv-bot-info jv-ui ${section === "activity" ? "jv-bot-activity-shell" : ""}`} aria-describedby={undefined}>
      {section === "activity" ? <BotActivity botId={bot.id} botName={bot.name} onBack={() => setSection("info")} onOpenChat={onOpenChat}/> : <>
      <DialogHeader className="jv-dialog-header"><DialogTitle>Bot 信息</DialogTitle></DialogHeader>
      <div className="jv-bot-scroll">
        <section className="jv-bot-hero">
          <BotAvatar color={bot.color} mood={bot.mood} size={72}/>
          <div className="jv-bot-identity">
            <strong>{bot.name}</strong>
            <span>{bot.description || "还没有描述"}</span>
            <div className="jv-bot-colors" role="radiogroup" aria-label="形象颜色">
              {(Object.keys(BOT_COLORS) as BotColor[]).map(color => <button key={color} type="button" role="radio" aria-checked={bot.color === color}
                aria-label={BOT_COLORS[color].label} title={BOT_COLORS[color].label} disabled={busy} style={{ background: colorHex(color) }} onClick={() => void changeColor(color)}/>)}
            </div>
            {note(colorNote)}
          </div>
        </section>

        <section className="jv-section" aria-label="模型"><h3 className="jv-section-title">模型</h3>
          <div className="jv-panel">
            <BotModelControls bot={bot} connections={connections} onSaved={onSaved} onManage={onManageModels}/>
            {context && <div className="jv-context" title="Pi 上下文估算">
              <div className="jv-context-label"><span>上下文</span><span>{context.tokens === null ? "未知" : `${context.tokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens`}</span></div>
              {context.tokens !== null && <div className="jv-context-bar"><span style={{ width: `${Math.min(100, Math.max(1, (context.tokens / context.contextWindow) * 100))}%` }}/></div>}
            </div>}
          </div>
        </section>

        <section className="jv-section" aria-label="个人设定"><h3 className="jv-section-title">个人设定</h3>
          <form className="jv-panel" onSubmit={event => void save(event)}>
            <label className="jv-field"><span>名称</span><Input id="jarvy-bot-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
            <label className="jv-field"><span>描述</span><Textarea id="jarvy-bot-description" maxLength={1000} rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder="这个 Bot 能帮你做什么？"/></label>
            <label className="jv-field"><span>Persona</span><Textarea id="jarvy-bot-persona" maxLength={16000} rows={7} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="Bot 的性格、职责与行为偏好"/>
              <small className="jv-hint">作为系统提示词的一部分，下一次执行时生效。</small></label>
            <div className="jv-form-footer">{note(profileNote?.kind === "error" || !dirty ? profileNote : null) ?? (dirty ? <p className="jv-hint">有未保存的修改</p> : <span/>)}
              <Button type="submit" className="jv-primary" disabled={busy || !dirty}>{busy ? "保存中…" : "保存"}</Button></div>
          </form>
        </section>

        <section className="jv-section" aria-label="运行"><h3 className="jv-section-title">运行</h3>
          <div className="jv-list">
            <div className="jv-list-row jv-static-row">
              <span className="jv-row-text"><strong>状态</strong><span>停止后保留原会话，启动不会主动请求模型</span></span>
              <span className="jv-status" data-ok={runtime !== "stop" || undefined} data-busy={runtime === "running" || undefined}>{STATUS_LABEL[runtime]}</span>
              {runtime === "running" && <Button type="button" variant="ghost" size="sm" disabled={!!control} onClick={() => void controlRuntime("abort")}>{control === "abort" ? "取消中…" : "取消本轮"}</Button>}
              <Button type="button" variant="outline" size="sm" disabled={!!control || !bot.connectionId} onClick={() => void controlRuntime(runtime === "stop" ? "start" : "stop")}>
                {control === "start" ? "启动中…" : control === "stop" ? "停止中…" : runtime === "stop" ? "启动" : "停止"}</Button>
            </div>
            <div className="jv-list-row jv-static-row">
              <span className="jv-row-text"><strong>工作区</strong><code title={bot.workspacePath}>{bot.workspacePath}</code></span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? "已复制" : "复制工作区路径"} onClick={() => void copyText(bot.workspacePath).then(ok => setCopied(ok))}>{copied ? <CheckIcon/> : <CopyIcon/>}</Button>
            </div>
            <button type="button" className="jv-list-row" onClick={() => setSection("activity")}>
              <span className="jv-row-icon"><HistoryIcon/></span>
              <span className="jv-row-text"><strong>活动历史</strong><span>聊天发言与 History 时间线</span></span>
              <ChevronRightIcon className="jv-row-chevron"/>
            </button>
          </div>
          {controlError && <p className="jv-note-error" role="alert">{controlError}</p>}
        </section>

        {subscriptions && <section className="jv-section" aria-label="订阅"><h3 className="jv-section-title">订阅</h3>
          <div className="jv-list">
            {subscriptions.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>暂无订阅</span></span></div>
              : subscriptions.map(chat => <button key={chat.id} type="button" className="jv-list-row" onClick={() => onOpenSubscription(chat)}>
                <span className="jv-row-icon">{chat.type === "thread" ? <MessagesSquareIcon/> : <HashIcon/>}</span>
                <span className="jv-row-text"><strong>{chat.title}</strong>
                  <span>{chat.type === "thread" ? `线程 · #${chats.find(item => item.id === chat.parentId)?.title ?? ""}` : "频道"}</span></span>
                <ChevronRightIcon className="jv-row-chevron"/>
              </button>)}
          </div>
        </section>}
      </div></>}
    </DialogContent>
  </Dialog>;
}
