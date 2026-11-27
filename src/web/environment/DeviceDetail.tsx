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

/** One computer the desktop client connected (A96), on the Environments page Overview tab:
 * two-column layout with runtime configuration on the left and Bot grants + device details on the right. */
export function DeviceDetail({ device, bots, onChanged, onDeleted }: { device: Device; bots: Bot[]; onChanged: (device: Device) => void; onDeleted: () => void }) {
  const [name, setName] = useState(device.name), [directory, setDirectory] = useState(device.directory), [description, setDescription] = useState(device.description);
  const [confirming, setConfirming] = useState(false), { busy, error, setError, run: act } = useAction<"save" | "shell" | "delete">();
  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    const saved = await api.updateDevice(device.id, { name: name.trim(), directory: directory.trim(), description: description.trim() });
    onChanged(saved); setName(saved.name); setDirectory(saved.directory); setDescription(saved.description);
  }); };
  const edited = name.trim() !== device.name || directory.trim() !== device.directory || description.trim() !== device.description;

  return <div className="jv-ov-grid">
    <section className="jv-ov-col" aria-label={t("envs.sectionConfig")}>
      <h3 className="jv-ov-heading">{t("envs.sectionConfig")}</h3>
      <div className="jv-list jv-machine-detail">
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
        <div className="jv-list-row jv-static-row jv-secret-details">
          <form className="jv-secret-edit jv-machine-edit" onSubmit={save} aria-label={device.name}>
            <label className="jv-field"><span>{t("machines.name")}</span><Input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
            <label className="jv-field"><span>{t("machines.directory")}</span>
              <Input className="jv-mono" required maxLength={1000} spellCheck={false} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
            <label className="jv-field jv-machine-description"><span>{t("machines.description")}</span>
              <Textarea maxLength={2000} rows={3} placeholder={t("machines.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
            <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !edited || !name.trim()}>{t("common.save")}</Button></div>
          </form>
        </div>
      </div>
    </section>

    <div className="jv-ov-col jv-ov-side">
      <section aria-label={t("envs.sectionAccess")}>
        <h3 className="jv-ov-heading">{t("envs.sectionAccess")}</h3>
        <div className="jv-list jv-machine-detail">
          <div className="jv-list-row jv-static-row jv-secret-details">
            <BotGrants grantedIds={device.botIds} bots={bots} hideHeading
              onGrant={async (ids, granted) => { let saved = device; for (const id of ids) saved = await api.grantDevice(device.id, id, granted); onChanged(saved); }}/>
          </div>
        </div>
      </section>

      <section aria-label={t("envs.sectionDanger")}>
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
      </section>
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>
  </div>;
}

/** How to connect a computer until the desktop client is there (A96): the command-line client, fetched from this
 * Jarvy, for Windows and for macOS and Linux. */
export function DeviceConnect() {
  const origin = window.location.origin, url = `${origin}/api/devices/connector.mjs`, insecure = origin.startsWith("https:") ? " -k" : "";
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
