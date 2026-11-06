import { useState, type FormEvent } from "react";
import { type Bot } from "../../contract/bots";
import { api } from "../api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { errorText } from "../errors";
import { t } from "../i18n";

/** Bot info → 设定: name, description and Persona, saved together. Edits stay while other tabs are open. */
export function BotProfile({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [systemPrompt, setSystemPrompt] = useState(bot.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const dirty = name !== bot.name || description !== bot.description || systemPrompt !== bot.systemPrompt;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNote(null);
    try { onSaved(await api.saveBot(bot.id, { name, description, systemPrompt })); setNote({ kind: "ok", text: t("bot.saved") }); }
    catch (reason) { setNote({ kind: "error", text: errorText(reason, "common.saveFailed") }); }
    finally { setBusy(false); }
  }
  const shown = note?.kind === "error" || !dirty ? note : null;
  return <form className="jv-bot-profile" onSubmit={event => void save(event)}>
    <label className="jv-field"><span>{t("info.name")}</span><Input id="jarvy-bot-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
    <label className="jv-field"><span>{t("bot.description")}</span><Textarea id="jarvy-bot-description" maxLength={1000} rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder={t("bot.descriptionPlaceholder")}/></label>
    <label className="jv-field jv-bot-persona"><span>Persona</span><Textarea id="jarvy-bot-persona" maxLength={16000} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder={t("bot.personaPlaceholder")}/>
      <small className="jv-hint">{t("bot.personaHint")}</small></label>
    <div className="jv-form-footer">{shown ? <p className={shown.kind === "error" ? "jv-note-error" : "jv-note-ok"} role={shown.kind === "error" ? "alert" : "status"}>{shown.text}</p>
      : dirty ? <p className="jv-hint">{t("bot.unsaved")}</p> : <span/>}
      <Button type="submit" className="jv-primary" disabled={busy || !dirty}>{t(busy ? "bot.saving" : "common.save")}</Button></div>
  </form>;
}
