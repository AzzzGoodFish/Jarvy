import { useState } from "react";
import { Popover } from "radix-ui";
import type { ComputerCapacity, ComputerLimits, ComputerUsage } from "../../contract/environment";
import { t } from "../i18n";
import { GB, cores, short, size } from "./amounts";

/** What a running sandbox uses (A75, A85), a row for each of its memory, CPU and a VM's Docker disk: the figure against
 * its limit, or this machine's whole where it has none, with a bar. A VM's memory and disk tell what they take of this
 * machine on hover, or a tap where there is no hover. */
export function SandboxUsage({ usage, limits, capacity }: { usage: ComputerUsage; limits: ComputerLimits; capacity: ComputerCapacity | null }) {
  const memory = limits.memory ?? capacity?.memory ?? null, cpus = limits.cpus ?? capacity?.cpus ?? null;
  const of = (used: string, whole: string | null, machine: boolean) => whole === null ? used : machine ? t("environment.usage.machine", { used, whole }) : `${used} / ${whole}`;
  return <>
    <Meter label={t("environment.usage.memory")} share={memory && usage.memory / memory} host={usage.host?.memory}
      text={of(size(usage.memory), memory === null ? null : `${short(memory / GB, limits.memory === null ? 1 : 2)} GB`, limits.memory === null)}/>
    <Meter label={t("environment.usage.cpu")} share={cpus && usage.cpu / 100 / cpus}
      text={of(short(usage.cpu / 100), cpus === null ? null : cores(cpus), limits.cpus === null)}/>
    {usage.disk && <Meter label={t("environment.usage.disk")} share={usage.disk.used / usage.disk.size} host={usage.host?.disk}
      text={of(size(usage.disk.used), `${short(usage.disk.size / GB)} GB`, false)}/>}
  </>;
}

/** One resource's row: a bar under its figure when it has a whole to be measured against, turning to the warning colour
 * past nine tenths. `host`, a VM's take of this machine, opens from the row. */
function Meter({ label, text, share, host }: { label: string; text: string; share: number | null; host?: number | null }) {
  const [open, setOpen] = useState(false);
  const body = <>
    <span>{label}</span><span className="jv-env-value">{text}</span>
    {share !== null && <span className="jv-env-bar" aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(1, share * 100))}%` }} data-high={share > 0.9 || undefined}/></span>}
  </>;
  if (host === undefined || host === null) return <div className="jv-list-row jv-static-row jv-env-fact jv-env-meter">{body}</div>;
  const hover = (on: boolean) => (event: React.PointerEvent) => { if (event.pointerType === "mouse") setOpen(on); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="jv-list-row jv-env-fact jv-env-meter" onPointerEnter={hover(true)} onPointerLeave={hover(false)}>{body}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="jv-env-tip jv-ui" side="top" align="end" sideOffset={4} collisionPadding={12}
      onOpenAutoFocus={event => event.preventDefault()}>{t("environment.usage.host", { value: size(host) })}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}
