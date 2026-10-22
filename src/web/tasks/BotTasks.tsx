import { useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";
import { api, type Bot, type Chat, type Task, type TaskInput } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import { TaskEditor } from "./TaskEditor";
import { moment, scheduleText } from "./schedule";
import "../styles/tasks.css";

/** Bot info's scheduled tasks (A57), laid out like an alarm list: each task is a row with its switch, and touching
 * the row opens its details, where it is changed, saved or deleted. The Bot's own tasks and the owner's for it are
 * here alike. `runs` changes when the Bot starts or ends a turn, which is when it may have run or changed a task, so
 * the list reloads then. */
export function BotTasks({ bot, chats, runs }: { bot: Bot; chats: Chat[]; runs: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [open, setOpen] = useState<Task | "new" | null>(null);
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
  async function show(target: Task | "new") {
    setError(""); setEditorError("");
    // A Bot always has a DM with its owner; it is made here if the owner never opened it.
    if (!dm) try { setDm(await api.createChat(bot.id)); } catch (reason) { setError(errorText(reason, "common.failed")); return; }
    setOpen(target);
  }
  async function save(input: TaskInput) {
    setBusy(true); setEditorError("");
    try { replace(open === "new" || !open ? await api.createTask(bot.id, input) : await api.updateTask(bot.id, open.id, input)); setOpen(null); }
    catch (reason) { setEditorError(errorText(reason, "tasks.saveFailed")); }
    finally { setBusy(false); }
  }
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (reason) { setError(errorText(reason, "tasks.changeFailed")); } finally { setBusy(false); }
  }
  const toggle = (task: Task) => act(async () => replace(await api.setTaskOn(bot.id, task.id, task.state !== "active")));
  const remove = (task: Task) => act(async () => {
    await api.deleteTask(bot.id, task.id);
    setTasks(current => current?.filter(item => item.id !== task.id) ?? null);
    setOpen(null);
  });
  // A one-off already says when; others say when they next run, or that they are off or done.
  const status = (task: Task) => task.state === "active" ? task.schedule.kind === "once" || !task.nextRunAt ? "" : t("tasks.next", { time: moment(task.nextRunAt) })
    : t(task.state === "done" ? "tasks.done" : "tasks.paused");
  const line = (task: Task) => [scheduleText(task.schedule), status(task)].filter(Boolean).join(" · ");
  return <section className="jv-section" aria-label={t("tasks.title")}>
    <div className="jv-task-head"><h3 className="jv-section-title">{t("tasks.title")}</h3>
      {!open && <Button type="button" variant="ghost" size="sm" disabled={busy || tasks === null} onClick={() => void show("new")}><PlusIcon/>{t("tasks.add")}</Button>}</div>
    {open ? <TaskEditor task={open === "new" ? undefined : open} chats={places} botName={bot.name} busy={busy} error={editorError}
      onSave={input => void save(input)} onCancel={() => setOpen(null)} {...(open === "new" ? {} : { onDelete: () => void remove(open) })}/>
      : tasks && <div className="jv-list">
        {tasks.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("tasks.empty")}</span></span></div>
          : tasks.map(task => <div key={task.id} className="jv-task-row" data-state={task.state}>
            <button type="button" className="jv-list-row jv-task-open" aria-label={task.name} onClick={() => void show(task)}>
              <span className="jv-row-text"><strong>{task.name}</strong><span>{line(task)}</span></span>
            </button>
            {task.state !== "done" && <button type="button" role="switch" aria-checked={task.state === "active"} aria-label={t("tasks.toggle", { name: task.name })} disabled={busy}
              className="jv-env-access jv-task-switch" onClick={() => void toggle(task)}><span className="jv-env-switch" aria-hidden="true"/></button>}
          </div>)}
      </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
