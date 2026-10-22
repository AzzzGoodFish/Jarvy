import { useEffect, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { api, type Bot, type Chat, type Task, type TaskInput } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import { TaskEditor } from "./TaskEditor";
import { moment, scheduleText } from "./schedule";
import "../styles/tasks.css";

/** Bot info's scheduled tasks (A56): the Bot's own and those the owner made for it, with a switch to turn each on or
 * off, and editing and deleting in place (Bot info is itself a dialog). `runs` changes when the Bot starts or ends a
 * turn, which is when it may have run or changed a task, so the list reloads then. */
export function BotTasks({ bot, chats, runs }: { bot: Bot; chats: Chat[]; runs: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [dm, setDm] = useState<Chat | null>(() => chats.find(chat => chat.type === "dm" && chat.botId === bot.id) ?? null);
  useEffect(() => {
    let alive = true;
    void api.tasks(bot.id).then(result => { if (alive) setTasks(result.tasks); }).catch(reason => { if (alive) setError(errorText(reason, "tasks.loadFailed")); });
    return () => { alive = false; };
  }, [bot.id, runs]);
  // Where the Bot can be told: its DM with the owner, then the channels it is in.
  const places = [...(dm ? [dm] : []), ...chats.filter(chat => chat.type === "channel" && chat.memberIds.includes(bot.id))];
  const replace = (task: Task) => setTasks(current => (current ?? []).some(item => item.id === task.id)
    ? current!.map(item => item.id === task.id ? task : item) : [...current ?? [], task]);
  async function open(target: Task | "new") {
    setError(""); setEditorError("");
    // A Bot always has a DM with its owner; it is made here if the owner never opened it.
    if (!dm) try { setDm(await api.createChat(bot.id)); } catch (reason) { setError(errorText(reason, "common.failed")); return; }
    setEditing(target);
  }
  async function save(input: TaskInput) {
    setBusy(true); setEditorError("");
    try { replace(editing === "new" || !editing ? await api.createTask(bot.id, input) : await api.updateTask(bot.id, editing.id, input)); setEditing(null); }
    catch (reason) { setEditorError(errorText(reason, "tasks.saveFailed")); }
    finally { setBusy(false); }
  }
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (reason) { setError(errorText(reason, "tasks.changeFailed")); } finally { setBusy(false); }
  }
  const toggle = (task: Task) => act(async () => replace(await api.setTaskOn(bot.id, task.id, task.state !== "active")));
  const remove = (task: Task) => act(async () => { await api.deleteTask(bot.id, task.id); setTasks(current => current?.filter(item => item.id !== task.id) ?? null); setConfirming(null); });
  // A one-off already says when; others say when they next run, or that they are off or done.
  const status = (task: Task) => task.state === "active" ? task.schedule.kind === "once" || !task.nextRunAt ? "" : t("tasks.next", { time: moment(task.nextRunAt) })
    : t(task.state === "done" ? "tasks.done" : "tasks.paused");
  const line = (task: Task) => [scheduleText(task.schedule), status(task)].filter(Boolean).join(" · ");
  return <section className="jv-section" aria-label={t("tasks.title")}>
    <div className="jv-task-head"><h3 className="jv-section-title">{t("tasks.title")}</h3>
      {!editing && <Button type="button" variant="ghost" size="sm" disabled={busy || tasks === null} onClick={() => void open("new")}><PlusIcon/>{t("tasks.add")}</Button>}</div>
    {editing ? <TaskEditor task={editing === "new" ? undefined : editing} chats={places} botName={bot.name} busy={busy} error={editorError}
      onSave={input => void save(input)} onCancel={() => setEditing(null)}/>
      : tasks && <div className="jv-list">
        {tasks.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("tasks.empty")}</span></span></div>
          : tasks.map(task => <div key={task.id} className="jv-list-row jv-static-row jv-task-row" data-state={task.state}>
            <span className="jv-row-text"><strong>{task.name}</strong><span>{line(task)}</span></span>
            {confirming === task.id ? <div className="jv-env-confirm jv-task-confirm" role="group" aria-label={t("tasks.deleteTitle", { name: task.name })}>
              <strong>{t("tasks.deleteTitle", { name: task.name })}</strong><p>{t("tasks.deleteBody")}</p>
              <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
                <Button type="button" className="jv-danger" size="sm" disabled={busy} onClick={() => void remove(task)}>{t("tasks.delete")}</Button></div>
            </div> : <>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.edit")} title={t("tasks.edit")} disabled={busy} onClick={() => void open(task)}><PencilIcon/></Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.delete")} title={t("tasks.delete")} disabled={busy} onClick={() => setConfirming(task.id)}><Trash2Icon/></Button>
              {task.state !== "done" && <button type="button" role="switch" aria-checked={task.state === "active"} aria-label={t("tasks.toggle", { name: task.name })} disabled={busy}
                className="jv-env-access jv-task-switch" onClick={() => void toggle(task)}><span className="jv-env-switch" aria-hidden="true"/></button>}
            </>}
          </div>)}
      </div>}
    {!editing && <p className="jv-hint jv-env-note">{t("tasks.hint")}</p>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
