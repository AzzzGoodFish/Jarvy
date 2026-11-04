import { type FormEvent, useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import type { ComputerLimits, ComputerResources } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAction } from "../action";

const GB = 2 ** 30, MB = 2 ** 20;
/** At most two decimals, none when whole: 8, 0.5, 62.88. */
const short = (value: number, digits = 2) => String(Number(value.toFixed(digits)));
/** A size in use: megabytes below a gigabyte, else gigabytes to one decimal. */
const size = (bytes: number) => bytes < GB ? `${Math.round(bytes / MB)} MB` : `${short(bytes / GB, 1)} GB`;
const percent = (value: number) => `${value < 10 ? short(value, 1) : Math.round(value)}%`;
const cores = (count: number) => count === 1 ? t("environment.limits.oneCore") : t("environment.limits.cores", { count: short(count) });

/** What the limits row says: no limits, or each limit with the other unlimited. */
function limitsText({ memory, cpus }: ComputerLimits): string {
  if (memory === null && cpus === null) return t("environment.limits.none");
  const unlimited = t("environment.limits.unlimited");
  return `${t("environment.limits.memory", { value: memory === null ? unlimited : `${short(memory / GB)} GB` })} · ${t("environment.limits.cpu", { value: cpus === null ? unlimited : cores(cpus) })}`;
}

/** Bot info's resource rows for a sandbox (A75): the limits, changed in place, and while it runs what it uses now,
 * read again every ten seconds. A field left empty is no limit; memory below what is in use warns first, since the
 * kernel then ends its largest programs. */
export function SandboxLimits({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const computer = bot.environment.computer!, running = computer.state === "running";
  const [resources, setResources] = useState<ComputerResources | null>(null);
  const [editing, setEditing] = useState(false);
  const [memory, setMemory] = useState(""), [cpus, setCpus] = useState("");
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    let alive = true;
    const load = () => void api.computerResources(bot.id).then(next => { if (alive) setResources(next); }).catch(() => {});
    load();
    const timer = running ? setInterval(load, 10_000) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [bot.id, running]);
  const usage = running ? resources?.usage ?? null : null, capacity = resources?.capacity ?? null;
  function edit() {
    setMemory(computer.limits.memory === null ? "" : short(computer.limits.memory / GB));
    setCpus(computer.limits.cpus === null ? "" : short(computer.limits.cpus));
    setError(""); setEditing(true);
  }
  const asked: ComputerLimits = { memory: memory.trim() ? Math.round(Number(memory) * GB) : null, cpus: cpus.trim() ? Number(cpus) : null };
  const below = usage && asked.memory !== null && asked.memory < usage.memory;
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run("save", async () => { onSaved(await api.setComputerLimits(bot.id, asked)); setEditing(false); }, "environment.limits.failed");
  };
  return <>
    <button type="button" className="jv-list-row jv-env-fact jv-env-limits" aria-expanded={editing} onClick={() => editing ? setEditing(false) : edit()}>
      <span>{t("environment.limits")}</span><span className="jv-env-value">{limitsText(computer.limits)}</span><ChevronRightIcon className="jv-row-chevron"/>
    </button>
    {usage && !editing && <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.usage")}</span>
      <span className="jv-env-value">{t("environment.usage.value", { memory: size(usage.memory), cpu: percent(usage.cpu) })}</span></div>}
    {editing && <div className="jv-list-row jv-static-row jv-env-details">
      <form className="jv-env-limits-form" aria-label={t("environment.limits.edit")} onSubmit={save}>
        <div className="jv-env-limit-fields">
          <label className="jv-field"><span>{t("environment.limits.memoryField")}</span>
            <Input type="number" inputMode="decimal" min={0.25} max={capacity ? Number((capacity.memory / GB).toFixed(2)) : undefined} step="any"
              placeholder={t("environment.limits.unlimited")} value={memory} onChange={event => { setMemory(event.target.value); setError(""); }}/></label>
          <label className="jv-field"><span>{t("environment.limits.cpuField")}</span>
            <Input type="number" inputMode="decimal" min={0.1} max={capacity?.cpus} step="any"
              placeholder={t("environment.limits.unlimited")} value={cpus} onChange={event => { setCpus(event.target.value); setError(""); }}/></label>
        </div>
        {capacity && <small className="jv-hint">{t("environment.limits.machine", { cpus: capacity.cpus, memory: short(capacity.memory / GB, 1) })}</small>}
        {below && <p className="jv-env-warn" role="status">{t("environment.limits.below", { usage: size(usage.memory) })}</p>}
        {error && <p className="jv-note-error" role="alert">{error}</p>}
        <div className="jv-env-confirm-actions">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
          <Button type="submit" className="jv-primary" size="sm" disabled={busy}>{t("common.save")}</Button>
        </div>
      </form>
    </div>}
  </>;
}
