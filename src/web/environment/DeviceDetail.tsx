import { useState, type FormEvent } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Device, type DeviceShell } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useAction } from "../action";
import { BotGrants } from "../secrets/SecretGrants";
import { GB, short } from "./amounts";
import { allowsHostAccess, isComputeNode, isSandboxOnly } from "./device-roles";
import { MachineKeyLine } from "./MachineKey";

const SHELLS: readonly (DeviceShell | "auto")[] = ["auto", "bash", "powershell"];
const PLATFORM: Record<string, "devices.platform.win32" | "devices.platform.darwin" | "devices.platform.linux"> = { win32: "devices.platform.win32", darwin: "devices.platform.darwin", linux: "devices.platform.linux" };
/** A computer's system in the interface's words, with its architecture. */
export const deviceSystem = (device: Device) => [PLATFORM[device.platform] ? t(PLATFORM[device.platform]!) : device.platform, device.arch].filter(Boolean).join(" · ");
/** Online, paused in its client, or offline. */
export const deviceState = (device: Device): "online" | "paused" | "offline" => !device.online ? "offline" : device.paused ? "paused" : "online";
const shellName = (device: Device, shell: DeviceShell) => t(shell === "powershell" ? "devices.shellPowershell" : device.platform === "win32" ? "devices.shellBash" : "devices.shellBashOther");

/** One `jarvy client` node on the Environments Overview tab (A96, A108, A109):
 * adapts its primary layout by role — Compute Pool nodes highlight sandbox capacity & hosted Bots first,
 * pure `--sandbox-only` nodes hide host shell/directory/access controls, and Remote Host nodes focus on host access. */
export function DeviceDetail({ device, bots, onChanged, onBotChanged, onDeleted }: {
  device: Device; bots: Bot[]; onChanged: (device: Device) => void; onBotChanged?: (bot: Bot) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(device.name), [directory, setDirectory] = useState(device.directory), [description, setDescription] = useState(device.description);
  const [confirming, setConfirming] = useState(false), [reclaimingId, setReclaimingId] = useState<string | null>(null);
  const { busy, error, setError, run: act } = useAction<"save" | "shell" | "delete" | "reclaim">();
  const hostedBots = bots.filter(b => b.environment.computer?.computeNode?.id === device.id);
  const compute = isComputeNode(device);
  const hostAllowed = allowsHostAccess(device);
  const sandboxOnly = isSandboxOnly(device);

  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    const saved = await api.updateDevice(device.id, {
      name: name.trim(),
      ...(hostAllowed ? { directory: directory.trim() } : {}),
      description: description.trim(),
    });
    onChanged(saved); setName(saved.name); setDirectory(saved.directory); setDescription(saved.description);
  }); };
  const edited = name.trim() !== device.name || (hostAllowed && directory.trim() !== device.directory) || description.trim() !== device.description;

  const poolSection = compute ? <section aria-label={t("devices.poolSection")}>
    <h3 className="jv-ov-heading">{t("devices.poolSection")}</h3>
    <div className="jv-list jv-machine-detail">
      {device.sandbox ? <>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("devices.poolSandboxes")}</span>
          <code>{device.sandbox.activeContainers} / {device.sandbox.maxContainers}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("devices.poolCapacity")}</span>
          <span className="jv-env-value">{t("environment.limits.machine", { cpus: device.sandbox.cpus, memory: short(device.sandbox.memory / GB, 1) })}</span>
        </div>
        {device.sandbox.image && <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("environment.image")}</span>
          <code>{device.sandbox.image}</code>
        </div>}
      </> : <div className="jv-list-row jv-static-row"><p className="jv-hint">{t("devices.poolOffline")}</p></div>}
      <div className="jv-list-row jv-static-row"><p className="jv-hint">{t("devices.poolIsolationHint")}</p></div>
      {hostedBots.length > 0 ? hostedBots.map(bot => <div key={bot.id} className="jv-list-row jv-static-row jv-pool-bot-row">
        <span className="jv-row-text"><strong>{t("envs.sandboxOf", { name: bot.name })}</strong>
          <span className="jv-mono">{bot.environment.computer?.container}</span></span>
        <Button type="button" variant="outline" size="sm" disabled={busy || reclaimingId === bot.id} onClick={() => {
          setReclaimingId(bot.id);
          void act("reclaim", async () => {
            const updated = await api.reclaimComputer(bot.id);
            onBotChanged?.(updated);
          }).finally(() => setReclaimingId(null));
        }}>{t(reclaimingId === bot.id ? "environment.reclaiming" : "environment.reclaim")}</Button>
      </div>) : <div className="jv-list-row jv-static-row"><p className="jv-hint">{t("devices.poolEmpty")}</p></div>}
    </div>
  </section> : null;

  const configSection = <section aria-label={t("envs.sectionConfig")}>
    <h3 className="jv-ov-heading">{t("envs.sectionConfig")}</h3>
    <div className="jv-list jv-machine-detail">
      {hostAllowed && <>
        <div className="jv-list-row jv-static-row jv-ov-shell-row">
          <div className="jv-ov-shell-copy">
            <span className="jv-ov-row-title">{t("devices.shell")}</span>
            <span className="jv-ov-row-hint">{t("envs.defaultShellHint")}</span>
          </div>
          <div className="jv-seg" role="radiogroup" aria-label={t("devices.shell")}>
            {SHELLS.map(shell => <button key={shell} type="button" role="radio" aria-checked={device.shell === shell}
              disabled={busy || (shell !== "auto" && !device.shells[shell])} title={shell !== "auto" ? device.shells[shell] ?? t("devices.shellMissing") : undefined}
              onClick={() => { if (shell !== device.shell) void act("shell", async () => onChanged(await api.updateDevice(device.id, { shell }))); }}>
              {shell === "auto" ? t("devices.shellAuto") : shellName(device, shell)}</button>)}
          </div>
        </div>
        {device.platform && !device.activeShell && <div className="jv-list-row jv-static-row"><p className="jv-hint" data-warn>{t("devices.noShell")}</p></div>}
      </>}
      <div className="jv-list-row jv-static-row jv-secret-details">
        <form className="jv-secret-edit jv-machine-edit" onSubmit={save} aria-label={device.name}>
          <label className="jv-field"><span>{t("machines.name")}</span><Input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
          {hostAllowed && <label className="jv-field"><span>{t("machines.directory")}</span>
            <Input className="jv-mono" required maxLength={1000} spellCheck={false} value={directory} onChange={event => setDirectory(event.target.value)}/></label>}
          <label className="jv-field jv-machine-description"><span>{t("machines.description")}</span>
            <Textarea maxLength={2000} rows={3} placeholder={t("machines.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
          <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !edited || !name.trim()}>{t("common.save")}</Button></div>
        </form>
      </div>
    </div>
  </section>;

  const accessSection = hostAllowed ? <section aria-label={t(compute ? "devices.hostAccessSection" : "envs.sectionAccess")}>
    <h3 className="jv-ov-heading">{t(compute ? "devices.hostAccessSection" : "envs.sectionAccess")}</h3>
    <div className="jv-list jv-machine-detail">
      {compute && <div className="jv-list-row jv-static-row"><p className="jv-hint">{t("devices.hostAccessHint")}</p></div>}
      <div className="jv-list-row jv-static-row jv-secret-details">
        <BotGrants grantedIds={device.botIds} bots={bots} hideHeading
          onGrant={async (ids, granted) => { let saved = device; for (const id of ids) saved = await api.grantDevice(device.id, id, granted); onChanged(saved); }}/>
      </div>
    </div>
  </section> : null;

  const dangerSection = <section aria-label={t("envs.sectionDanger")}>
    <h3 className="jv-ov-heading">{t("envs.sectionDanger")}</h3>
    <div className="jv-list jv-machine-detail jv-ov-danger-card">
      <div className="jv-list-row jv-static-row jv-ov-danger-row">
        {!confirming ? <>
          <div className="jv-ov-danger-copy">
            <span className="jv-ov-row-title">{t("devices.unpair")}</span>
            <span className="jv-ov-row-hint">{t("envs.unpairShort")}</span>
          </div>
          <Button type="button" variant="outline" size="sm" className="jv-ov-danger-btn" disabled={busy} onClick={() => setConfirming(true)}>
            {t("devices.unpair")}
          </Button>
        </> : <div className="jv-secret-confirm" role="group" aria-label={t("devices.unpairTitle", { name: device.name })}>
          <strong>{t("devices.unpairTitle", { name: device.name })}</strong><p>{t("devices.unpairBody")}</p>
          <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { setConfirming(false); setError(""); }}>{t("common.cancel")}</Button>
            <Button type="button" className="jv-primary jv-ov-danger-confirm" size="sm" disabled={busy} onClick={() => void act("delete", async () => { await api.deleteDevice(device.id); onDeleted(); })}>{t("devices.unpairConfirm")}</Button></div>
        </div>}
      </div>
    </div>
  </section>;

  return <div className="jv-ov-grid">
    <div className="jv-ov-col jv-ov-side">
      {compute && poolSection}
      {(!compute || !sandboxOnly) && configSection}
    </div>
    <div className="jv-ov-col jv-ov-side">
      {sandboxOnly && configSection}
      {accessSection}
      {dangerSection}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>
  </div>;
}

/** How to connect a `jarvy client` node: either as a Sandbox Compute Pool node or as a Remote Host / Desktop (A96, A108, A109). */
export function DeviceConnect({ mode }: { mode: "compute" | "host" }) {
  const origin = window.location.origin, url = `${origin}/api/devices/connector.mjs`, insecure = origin.startsWith("https:") ? " -k" : "";
  if (mode === "compute") {
    return <div className="jv-list jv-machine-detail"><div className="jv-list-row jv-static-row jv-secret-details jv-device-connect">
      <p className="jv-hint">{t("devices.connectComputeHint")}</p>
      <h4 className="jv-secret-heading">{t("devices.connectComputeOnlyCli")}</h4>
      <MachineKeyLine publicKey={`jarvy client start --sandbox-only ${origin}`}/>
      <h4 className="jv-secret-heading">{t("devices.connectComputeDualCli")}</h4>
      <MachineKeyLine publicKey={`jarvy client start --sandbox ${origin}`}/>
      <p className="jv-hint">{t("devices.connectComputeAfter")}</p>
    </div></div>;
  }
  return <div className="jv-list jv-machine-detail"><div className="jv-list-row jv-static-row jv-secret-details jv-device-connect">
    <p className="jv-hint">{t("devices.connectHint")}</p>
    <h4 className="jv-secret-heading">{t("devices.connectCli")}</h4>
    <MachineKeyLine publicKey={`jarvy client start ${origin}`}/>
    <h4 className="jv-secret-heading">{t("devices.connectWindows")}</h4>
    <MachineKeyLine publicKey={`curl.exe${insecure} -o connector.mjs ${url}; node connector.mjs ${origin}`}/>
    <h4 className="jv-secret-heading">{t("devices.connectOther")}</h4>
    <MachineKeyLine publicKey={`curl${insecure} -o connector.mjs ${url} && node connector.mjs ${origin}`}/>
    <p className="jv-hint">{t("devices.connectAfter")}</p>
  </div></div>;
}
