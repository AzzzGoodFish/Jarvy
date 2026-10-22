import { useState, type FormEvent } from "react";
import type { Chat, Task, TaskInput, TaskSchedule } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { localInput, timeInput, weekdayName } from "./schedule";

type Kind = TaskSchedule["kind"];
const KINDS = ["once", "every", "daily", "weekly"] as const;
const MIN_MINUTES = 5;
/** What the form holds for each kind, so switching kinds and back keeps what was typed. */
interface Draft { at: string; count: string; unit: "minutes" | "hours"; time: string; weekday: string }
function draftOf(schedule?: TaskSchedule): Draft {
  const soon = Date.now() + 60 * 60 * 1000;
  const draft: Draft = { at: localInput(soon - (soon % (5 * 60 * 1000))), count: "30", unit: "minutes", time: "09:00", weekday: "1" };
  if (!schedule) return draft;
  if (schedule.kind === "once") draft.at = localInput(schedule.at);
  if (schedule.kind === "every") Object.assign(draft, schedule.minutes % 60 === 0 ? { count: String(schedule.minutes / 60), unit: "hours" } : { count: String(schedule.minutes), unit: "minutes" });
  if (schedule.kind === "daily" || schedule.kind === "weekly") draft.time = timeInput(schedule.hour, schedule.minute);
  if (schedule.kind === "weekly") draft.weekday = String(schedule.weekday);
  return draft;
}
/** The schedule the form describes; null while it can't be one (an empty date, fewer than 5 minutes). */
function scheduleOf(kind: Kind, draft: Draft): TaskSchedule | null {
  const [hour, minute] = draft.time.split(":").map(Number);
  const clock = Number.isInteger(hour) && Number.isInteger(minute) ? { hour: hour!, minute: minute! } : null;
  if (kind === "once") { const at = new Date(draft.at).getTime(); return Number.isFinite(at) ? { kind, at } : null; }
  if (kind === "every") {
    const minutes = Number(draft.count) * (draft.unit === "hours" ? 60 : 1);
    return Number.isInteger(minutes) && minutes >= MIN_MINUTES ? { kind, minutes } : null;
  }
  if (!clock) return null;
  return kind === "daily" ? { kind, ...clock } : { kind, weekday: Number(draft.weekday), ...clock };
}

/** One task's details, open in place inside Bot info (A57): what an alarm's screen does — the fields to change, then
 * save, and delete for a task that already exists. `chats` are where the Bot can be told: its DM with the owner
 * first, then the channels it is in. */
export function TaskEditor({ task, chats, botName, busy, error, onSave, onDelete, onCancel }: {
  task?: Task; chats: Chat[]; botName: string; busy: boolean; error: string; onSave: (input: TaskInput) => void;
  /** Absent for a task that isn't saved yet. */
  onDelete?: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(task?.name ?? "");
  const [instruction, setInstruction] = useState(task?.instruction ?? "");
  const [kind, setKind] = useState<Kind>(task?.schedule.kind ?? "daily");
  const [draft, setDraft] = useState(() => draftOf(task?.schedule));
  const [chatId, setChatId] = useState(task?.chatId ?? chats[0]?.id ?? "");
  /** Deleting asks in place once; the button there confirms. */
  const [confirming, setConfirming] = useState(false);
  const schedule = scheduleOf(kind, draft);
  const change = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (schedule && name.trim() && instruction.trim() && chatId) onSave({ name: name.trim(), instruction: instruction.trim(), chatId, schedule });
  }
  const chatLabel = (chat: Chat) => chat.type === "dm" ? t("tasks.chatDm", { name: botName }) : `# ${chat.title}`;
  return <form className="jv-panel jv-task-editor" onSubmit={submit} aria-label={t(task ? "tasks.editTitle" : "tasks.newTitle")}>
    <label className="jv-field"><span>{t("tasks.name")}</span>
      <Input required maxLength={80} value={name} placeholder={t("tasks.namePlaceholder")} onChange={event => setName(event.target.value)}/></label>
    <label className="jv-field"><span>{t("tasks.instruction")}</span>
      <Textarea required maxLength={8000} rows={4} value={instruction} placeholder={t("tasks.instructionPlaceholder")} onChange={event => setInstruction(event.target.value)}/></label>
    <div className="jv-field"><span>{t("tasks.when")}</span>
      <div className="jv-env-seg jv-task-kinds" role="radiogroup" aria-label={t("tasks.when")}>
        {KINDS.map(item => <button key={item} type="button" role="radio" aria-checked={kind === item} onClick={() => setKind(item)}>{t(`tasks.kind.${item}`)}</button>)}
      </div>
      <div className="jv-task-when" data-kind={kind}>
        {kind === "once" && <Input type="datetime-local" aria-label={t("tasks.at")} value={draft.at} onChange={event => change({ at: event.target.value })}/>}
        {kind === "every" && <>
          <span className="jv-task-label">{t("tasks.everyCount")}</span>
          <Input type="number" min={draft.unit === "hours" ? 1 : MIN_MINUTES} step={1} aria-label={t("tasks.everyCount")} value={draft.count} onChange={event => change({ count: event.target.value })}/>
          <Select value={draft.unit} onValueChange={value => change({ unit: value as Draft["unit"] })}>
            <SelectTrigger aria-label={t("tasks.everyCount")}><SelectValue/></SelectTrigger>
            <SelectContent className="jv-select-menu">{(["minutes", "hours"] as const).map(unit => <SelectItem key={unit} value={unit}>{t(`tasks.unit.${unit}`)}</SelectItem>)}</SelectContent>
          </Select>
        </>}
        {kind === "weekly" && <Select value={draft.weekday} onValueChange={value => change({ weekday: value })}>
          <SelectTrigger aria-label={t("tasks.weekday")}><SelectValue/></SelectTrigger>
          <SelectContent className="jv-select-menu">{[1, 2, 3, 4, 5, 6, 0].map(day => <SelectItem key={day} value={String(day)}>{weekdayName(day)}</SelectItem>)}</SelectContent>
        </Select>}
        {(kind === "daily" || kind === "weekly") && <Input type="time" aria-label={t("tasks.time")} value={draft.time} onChange={event => change({ time: event.target.value })}/>}
      </div>
      {kind === "every" && !schedule && <small className="jv-hint">{t("tasks.minimum")}</small>}
    </div>
    <div className="jv-field"><span>{t("tasks.chat")}</span>
      <Select value={chatId} onValueChange={setChatId}>
        <SelectTrigger aria-label={t("tasks.chat")}><SelectValue/></SelectTrigger>
        <SelectContent className="jv-select-menu">{chats.map(chat => <SelectItem key={chat.id} value={chat.id}>{chatLabel(chat)}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    {confirming && onDelete && <div className="jv-env-confirm jv-task-confirm" role="group" aria-label={t("tasks.deleteTitle", { name: name || task?.name || "" })}>
      <strong>{t("tasks.deleteTitle", { name: name || task?.name || "" })}</strong><p>{t("tasks.deleteBody")}</p>
      <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        <Button type="button" variant="ghost" className="jv-task-delete" size="sm" disabled={busy} onClick={onDelete}>{t("tasks.delete")}</Button></div>
    </div>}
    <div className="jv-form-footer">
      <div className="jv-task-editor-actions">{onDelete && <Button type="button" variant="ghost" className="jv-task-delete" disabled={busy} onClick={() => setConfirming(true)}>{t("tasks.delete")}</Button>}</div>
      <div className="jv-task-editor-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" className="jv-primary" disabled={busy || !schedule || !name.trim() || !instruction.trim() || !chatId}>{t("common.save")}</Button>
      </div>
    </div>
  </form>;
}
