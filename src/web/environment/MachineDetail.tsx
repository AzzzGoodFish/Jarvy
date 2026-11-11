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
import { MachineKeyLine } from "./MachineKey";

/** Where a machine is, as ssh would be told: user@host, and the port when it isn't 22. */
export const machineAddress = (machine: SshMachine) => `${machine.user}@${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`;

/** One machine on the Environments page (A57, A59, A89): its name, start directory and notes; its fingerprint with a
 * check (and accepting a new one); how Jarvy logs in, with its public key (for a machine reached with its password: a
 * new password, or switching to the key); the Bots that may use it; and deleting it after confirming in place.
 * Deleting removes Jarvy's key from the machine first; when that fails it asks again. */
export function MachineDetail({ machine, bots, onChanged, onDeleted }: {
  machine: SshMachine; bots: Bot[]; onChanged: (machine: SshMachine) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(machine.name), [directory, setDirectory] = useState(machine.directory), [description, setDescription] = useState(machine.description);
  const [check, setCheck] = useState<{ hostKeys: HostKeys; changed: boolean } | null>(null);
  const [confirming, setConfirming] = useState<"delete" | "force" | null>(null), { busy, doing, error, setError, run: act } = useAction<"save" | "trust" | "check" | "key" | "password" | "delete">();
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), [loginNote, setLoginNote] = useState<string | null>(null);
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
  return <div className="jv-list jv-machine-detail"><div className="jv-list-row jv-static-row jv-secret-details">
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
    {!confirming ? <div className="jv-secret-actions jv-secret-danger">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming("delete")}>{t("machines.delete")}</Button></div>
      : <div className="jv-secret-confirm" role="group" aria-label={t(force ? "machines.forceTitle" : "machines.deleteTitle", { name: machine.name })}>
        <strong>{t(force ? "machines.forceTitle" : "machines.deleteTitle", { name: machine.name })}</strong>
        <p>{force ? t("machines.forceBody", { comment: `jarvy-${machine.id}` }) : t("machines.deleteBody")}</p>
        <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { setConfirming(null); setError(""); }}>{t("common.cancel")}</Button>
          <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={() => remove(force)}>{t(force ? "machines.forceConfirm" : "machines.deleteConfirm")}</Button></div>
      </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div></div>;
}
