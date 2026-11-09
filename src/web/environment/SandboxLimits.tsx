import { type FormEvent, useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import type { ComputerLimits, ComputerResources } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAction } from "../action";
import { GB, cores, short, size } from "./amounts";
import { SandboxUsage } from "./SandboxUsage";

/** What the limits row says: no limits, or each limit with the other unlimited. */
function limitsText({ memory, cpus }: ComputerLimits): string {
  if (memory === null && cpus === null) return t("environment.limits.none");
  const unlimited = t("environment.limits.unlimited");
  return `${t("environment.limits.memory", { value: memory === null ? unlimited : `${short(memory / GB)} GB` })} · ${t("environment.limits.cpu", { value: cpus === null ? unlimited : cores(cpus) })}`;
}

/** Bot info's resource rows for a sandbox (A75): the limits, changed in place, and while it runs what it uses now,
 * read again every ten seconds and shown while the limits change too. A field left empty is no limit; memory below
 * what is in use warns first, since the kernel then ends its largest programs. */
export function SandboxLimits({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const computer = bot.environment.computer!, running = computer.state === "running";
  // A VM (A85) always has a size: an empty field is its default, and it takes a new one at its next start.
  const vm = computer.type === "vm", least = vm ? { memory: 1, cpus: 1 } : { memory: 0.25, cpus: 0.1 };
  const empty = (field: "memory" | "cpus") => vm ? (field === "memory" ? "4" : "2") : t("environment.limits.unlimited");
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
  // A VM keeps its size until it restarts, so nothing in it is ended now.
  const below = !vm && usage && asked.memory !== null && asked.memory < usage.memory;
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run("save", async () => { onSaved(await api.setComputerLimits(bot.id, asked)); setEditing(false); }, "environment.limits.failed");
  };
  return <>
    <button type="button" className="jv-list-row jv-env-fact jv-env-limits" aria-expanded={editing} onClick={() => editing ? setEditing(false) : edit()}>
      <span>{t(vm ? "environment.limits.vm" : "environment.limits")}</span><span className="jv-env-value">{limitsText(computer.limits)}</span><ChevronRightIcon className="jv-row-chevron"/>
    </button>
    {usage && <SandboxUsage usage={usage} limits={computer.limits} capacity={capacity}/>}
    {editing && <div className="jv-list-row jv-static-row jv-env-details">
      <form className="jv-env-limits-form" aria-label={t(vm ? "environment.limits.vmEdit" : "environment.limits.edit")} onSubmit={save}>
        <div className="jv-env-limit-fields">
          <label className="jv-field"><span>{t("environment.limits.memoryField")}</span>
            <Input type="number" inputMode="decimal" min={least.memory} max={capacity ? Number((capacity.memory / GB).toFixed(2)) : undefined} step="any"
              placeholder={empty("memory")} value={memory} onChange={event => { setMemory(event.target.value); setError(""); }}/></label>
          <label className="jv-field"><span>{t("environment.limits.cpuField")}</span>
            <Input type="number" inputMode="decimal" min={least.cpus} max={capacity?.cpus} step="any"
              placeholder={empty("cpus")} value={cpus} onChange={event => { setCpus(event.target.value); setError(""); }}/></label>
        </div>
        {capacity && <small className="jv-hint">{t("environment.limits.machine", { cpus: capacity.cpus, memory: short(capacity.memory / GB, 1) })}</small>}
        {vm && <small className="jv-hint">{t("environment.limits.vmDefault")}</small>}
        {vm && running && <small className="jv-hint">{t("environment.limits.vmLater")}</small>}
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
