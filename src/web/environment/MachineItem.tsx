import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { type Bot } from "../../contract/bots";
import { type HostKeys, type SshMachine } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useAction } from "../action";
import { BotGrants } from "../secrets/SecretGrants";
import { SecretInput } from "../secrets/SecretInput";
import { SettingsItem } from "../secrets/SettingsItem";
import { MachineKeyLine } from "./MachineKey";

/** One machine in Settings → Environments (A57, A59): its row, and when open its details — the Bots that may use it,
 * its name and start directory, its fingerprint with a check (and accepting a new one), how Jarvy logs in with its
 * public key (for a machine reached with its password: a new password, or switching to the key), and deleting it after
 * confirming in place (Settings is a dialog). Deleting removes Jarvy's key from the machine first; when that fails it
 * asks again. */
export function MachineItem({ machine, bots, open, onToggle, onChanged, onDeleted }: {
  machine: SshMachine; bots: Bot[]; open: boolean; onToggle: () => void; onChanged: (machine: SshMachine) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(machine.name), [directory, setDirectory] = useState(machine.directory), [description, setDescription] = useState(machine.description);
  const [check, setCheck] = useState<{ hostKeys: HostKeys; changed: boolean } | null>(null);
  const [confirming, setConfirming] = useState<"delete" | "force" | null>(null), { busy, doing, error, setError, run: act } = useAction<"save" | "trust" | "check" | "key" | "password" | "delete">();
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), [loginNote, setLoginNote] = useState<string | null>(null);
  const address = `${machine.user}@${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`;
  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    const saved = await api.updateMachine(machine.id, { name: name.trim(), directory: directory.trim(), description: description.trim() });
    onChanged(saved); setName(saved.name); setDirectory(saved.directory); setDescription(saved.description);
  }); };
  // A plain delete that can't take Jarvy's key off the machine asks again, to delete anyway.
  const remove = (force: boolean) => void act("delete", async () => {
    try { await api.deleteMachine(machine.id, force); onDeleted(); }
    catch (reason) { if (!force && reason instanceof ApiError && reason.code !== "machine_missing") setConfirming("force"); throw reason; }
  });
  const edited = name.trim() !== machine.name || directory.trim() !== machine.directory || description.trim() !== machine.description;
  const force = confirming === "force";
  return <SettingsItem id={`machine-${machine.id}`} open={open} onToggle={onToggle} busy={busy} error={error}
    text={<><strong>{machine.name}</strong><span className="jv-mono">{address}</span></>}
    meta={<span className="jv-row-meta">{machine.botIds.length ? t("secrets.grantCount", { count: machine.botIds.length }) : t("secrets.notGranted")}</span>}
    remove={t("machines.delete")} confirming={confirming && { title: t(force ? "machines.forceTitle" : "machines.deleteTitle", { name: machine.name }),
      body: force ? t("machines.forceBody", { comment: `jarvy-${machine.id}` }) : t("machines.deleteBody"), confirm: t(force ? "machines.forceConfirm" : "machines.deleteConfirm") }}
    onAskRemove={() => setConfirming("delete")} onCancel={() => { setConfirming(null); setError(""); }} onConfirm={() => remove(force)}>
    <form className="jv-secret-edit jv-machine-edit" onSubmit={save} aria-label={machine.name}>
      <label className="jv-field"><span>{t("machines.name")}</span><Input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field"><span>{t("machines.directory")}</span>
        <Input className="jv-mono" required maxLength={1000} spellCheck={false} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
      <label className="jv-field jv-machine-description"><span>{t("machines.description")}</span>
        <Textarea maxLength={2000} rows={3} placeholder={t("machines.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !edited || !name.trim()}>{t("common.save")}</Button></div>
    </form>
    <div className="jv-machine-part">
      <section className="jv-secret-grants" aria-label={t("machines.fingerprint")}>
        <h4 className="jv-secret-heading">{t("machines.fingerprint")}</h4>
        <div className="jv-machine-key jv-machine-fingerprint">
          <div className="jv-machine-codes">{(check?.changed ? check.hostKeys.fingerprints : machine.fingerprints).map(print => <code key={print} data-new={check?.changed || undefined}>{print}</code>)}</div>
          {check?.changed ? <button type="button" className="ui-button jv-machine-copy" disabled={busy}
            onClick={() => void act("trust", async () => { onChanged(await api.trustMachine(machine.id, check.hostKeys.fingerprints)); setCheck(null); })}>{t("machines.trust")}</button>
            : <button type="button" className="ui-button jv-machine-copy" disabled={busy} onClick={() => void act("check", async () => {
              const result = await api.checkMachine(machine.id); setCheck(result); onChanged(result.machine); })}>
              {t(doing === "check" ? "machines.checking" : "machines.check")}</button>}
        </div>
        {check && <p className="jv-hint" data-warn={check.changed || undefined}>{t(check.changed ? "machines.changed" : "machines.unchanged")}</p>}
      </section>
      <section className="jv-secret-grants" aria-label={t("machines.login")}>
        <div className="jv-secret-grants-head"><h4 className="jv-secret-heading">{t("machines.login")}</h4>
          <span className="jv-row-meta">{t(machine.login === "password" ? "machines.loginPassword" : "machines.loginKey")}</span></div>
        {machine.publicKey && <MachineKeyLine publicKey={machine.publicKey}/>}
        {machine.login === "password" && <>
          <p className="jv-hint">{t("machines.passwordLogin")}</p>
          <form className="jv-machine-password" autoComplete="off" aria-label={t("machines.updatePassword")} onSubmit={event => {
            event.preventDefault(); void act("password", async () => { onChanged(await api.setMachinePassword(machine.id, password)); setPassword(""); setLoginNote(t("machines.passwordUpdated")); });
          }}>
            <label className="jv-field"><span>{t("machines.newPassword")}</span>
              <SecretInput value={password} visible={visible} onChange={setPassword} onVisible={setVisible} required warnShort={false}/></label>
            <div className="jv-secret-actions">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act("key", async () => {
                const result = await api.checkMachine(machine.id); setCheck(result); onChanged(result.machine);
                setLoginNote(t(result.machine.login === "key" ? "machines.usingKey" : "machines.stillPassword"));
              })}>{t("machines.useKey")}</Button>
              <Button type="submit" variant="outline" size="sm" disabled={busy || !password}>{t("machines.updatePassword")}</Button>
            </div>
          </form>
        </>}
        {loginNote && <p className="jv-hint">{loginNote}</p>}
      </section>
    </div>
    <div className="jv-machine-part">
      <BotGrants grantedIds={machine.botIds} bots={bots}
        onGrant={async (ids, granted) => { let saved = machine; for (const id of ids) saved = await api.grantMachine(machine.id, id, granted); onChanged(saved); }}/>
    </div>
  </SettingsItem>;
}
