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
import { MachineKeyLine } from "./MachineKey";

const SHELLS: readonly (DeviceShell | "auto")[] = ["auto", "bash", "powershell"];
const PLATFORM: Record<string, "devices.platform.win32" | "devices.platform.darwin" | "devices.platform.linux"> = { win32: "devices.platform.win32", darwin: "devices.platform.darwin", linux: "devices.platform.linux" };
/** A computer's system in the interface's words, with its architecture. */
export const deviceSystem = (device: Device) => [PLATFORM[device.platform] ? t(PLATFORM[device.platform]!) : device.platform, device.arch].filter(Boolean).join(" · ");
/** Online, paused in its client, or offline. */
export const deviceState = (device: Device): "online" | "paused" | "offline" => !device.online ? "offline" : device.paused ? "paused" : "online";
const shellName = (device: Device, shell: DeviceShell) => t(shell === "powershell" ? "devices.shellPowershell" : device.platform === "win32" ? "devices.shellBash" : "devices.shellBashOther");

/** One computer the desktop client connected (A96), on the Environments page: its name, start directory and notes; the
 * shell Bots' commands run in, of those it has; what it is and whether it is online; the Bots that may use it; and
 * unpairing it after confirming in place. */
export function DeviceDetail({ device, bots, onChanged, onDeleted }: { device: Device; bots: Bot[]; onChanged: (device: Device) => void; onDeleted: () => void }) {
  const [name, setName] = useState(device.name), [directory, setDirectory] = useState(device.directory), [description, setDescription] = useState(device.description);
  const [confirming, setConfirming] = useState(false), { busy, error, setError, run: act } = useAction<"save" | "shell" | "delete">();
  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    const saved = await api.updateDevice(device.id, { name: name.trim(), directory: directory.trim(), description: description.trim() });
    onChanged(saved); setName(saved.name); setDirectory(saved.directory); setDescription(saved.description);
  }); };
  const edited = name.trim() !== device.name || directory.trim() !== device.directory || description.trim() !== device.description;
  const state = deviceState(device);
  return <div className="jv-list jv-machine-detail"><div className="jv-list-row jv-static-row jv-secret-details">
    <form className="jv-secret-edit jv-machine-edit" onSubmit={save} aria-label={device.name}>
      <label className="jv-field"><span>{t("machines.name")}</span><Input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field"><span>{t("machines.directory")}</span>
        <Input className="jv-mono" required maxLength={1000} spellCheck={false} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
      <label className="jv-field jv-machine-description"><span>{t("machines.description")}</span>
        <Textarea maxLength={2000} rows={3} placeholder={t("machines.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !edited || !name.trim()}>{t("common.save")}</Button></div>
    </form>
    <div className="jv-machine-part jv-device-facts">
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("devices.system")}</span><span className="jv-env-value">{deviceSystem(device) || "—"}</span></div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("devices.state")}</span>
        <span className="jv-env-value"><span className="jv-status" data-ok={state === "online" || undefined}>{t(`devices.${state}`)}{state === "offline" && device.seenAt
          ? ` · ${t("devices.seen", { time: new Date(device.seenAt).toLocaleString() })}` : ""}</span></span></div>
      <div className="jv-list-row jv-static-row jv-env-fact jv-env-type"><span>{t("devices.shell")}</span>
        <div className="jv-seg" role="radiogroup" aria-label={t("devices.shell")}>
          {SHELLS.map(shell => <button key={shell} type="button" role="radio" aria-checked={device.shell === shell}
            disabled={busy || (shell !== "auto" && !device.shells[shell])} title={shell !== "auto" ? device.shells[shell] ?? t("devices.shellMissing") : undefined}
            onClick={() => { if (shell !== device.shell) void act("shell", async () => onChanged(await api.updateDevice(device.id, { shell }))); }}>
            {shell === "auto" ? device.activeShell ? `${t("devices.shellAuto")} · ${shellName(device, device.activeShell)}` : t("devices.shellAuto") : shellName(device, shell)}</button>)}
        </div>
      </div>
      {device.platform && !device.activeShell && <p className="jv-hint" data-warn>{t("devices.noShell")}</p>}
      {device.client && <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("devices.client")}</span><code>{device.client}</code></div>}
    </div>
    <div className="jv-machine-part">
      <BotGrants grantedIds={device.botIds} bots={bots}
        onGrant={async (ids, granted) => { let saved = device; for (const id of ids) saved = await api.grantDevice(device.id, id, granted); onChanged(saved); }}/>
    </div>
    {!confirming ? <div className="jv-secret-actions jv-secret-danger">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>{t("devices.unpair")}</Button></div>
      : <div className="jv-secret-confirm" role="group" aria-label={t("devices.unpairTitle", { name: device.name })}>
        <strong>{t("devices.unpairTitle", { name: device.name })}</strong><p>{t("devices.unpairBody")}</p>
        <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { setConfirming(false); setError(""); }}>{t("common.cancel")}</Button>
          <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={() => void act("delete", async () => { await api.deleteDevice(device.id); onDeleted(); })}>{t("devices.unpairConfirm")}</Button></div>
      </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div></div>;
}

/** How to connect a computer until the desktop client is there (A96): the command-line client, fetched from this
 * Jarvy, for Windows and for macOS and Linux. */
export function DeviceConnect() {
  const origin = window.location.origin, url = `${origin}/api/devices/connector.mjs`, insecure = origin.startsWith("https:") ? " -k" : "";
  return <div className="jv-list jv-machine-detail"><div className="jv-list-row jv-static-row jv-secret-details jv-device-connect">
    <p className="jv-hint">{t("devices.connectHint")}</p>
    <h4 className="jv-secret-heading">{t("devices.connectWindows")}</h4>
    <MachineKeyLine publicKey={`curl.exe${insecure} -o connector.mjs ${url}; node connector.mjs ${origin}`}/>
    <h4 className="jv-secret-heading">{t("devices.connectOther")}</h4>
    <MachineKeyLine publicKey={`curl${insecure} -o connector.mjs ${url} && node connector.mjs ${origin}`}/>
    <p className="jv-hint">{t("devices.connectAfter")}</p>
  </div></div>;
}
