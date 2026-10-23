import { useState, type FormEvent } from "react";
import { ChevronDownIcon } from "lucide-react";
import { ApiError, api, type Bot, type HostKeys, type SshMachine } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorText } from "../errors";
import { BotGrants } from "../secrets/SecretGrants";
import { SecretInput } from "../secrets/SecretInput";
import { MachineKeyLine } from "./MachineKey";

/** One machine in Settings → Environments (A57, A59): its row, and when open its details — the Bots that may use it,
 * its name and start directory, its fingerprint with a check (and accepting a new one), how Jarvy logs in with its
 * public key (for a machine reached with its password: a new password, or switching to the key), and deleting it after
 * confirming in place (Settings is a dialog). Deleting removes Jarvy's key from the machine first; when that fails it
 * asks again. */
export function MachineItem({ machine, bots, open, onToggle, onChanged, onDeleted }: {
  machine: SshMachine; bots: Bot[]; open: boolean; onToggle: () => void; onChanged: (machine: SshMachine) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(machine.name), [directory, setDirectory] = useState(machine.directory);
  const [check, setCheck] = useState<{ hostKeys: HostKeys; changed: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [confirming, setConfirming] = useState<"delete" | "force" | null>(null), [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), [loginNote, setLoginNote] = useState<string | null>(null);
  const details = `machine-${machine.id}`, address = `${machine.user}@${machine.host}${machine.port === 22 ? "" : `:${machine.port}`}`;
  const act = async (what: string, action: () => Promise<void>) => {
    setBusy(what); setError(null);
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(null); }
  };
  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    const saved = await api.updateMachine(machine.id, { name: name.trim(), directory: directory.trim() }); onChanged(saved); setName(saved.name); setDirectory(saved.directory);
  }); };
  const remove = (force: boolean) => void act("delete", async () => {
    try { await api.deleteMachine(machine.id, force); onDeleted(); }
    catch (reason) { if (!force && reason instanceof ApiError && reason.code !== "machine_missing") { setConfirming("force"); setError(errorText(reason)); return; } throw reason; }
  });
  const edited = name.trim() !== machine.name || directory.trim() !== machine.directory;
  return <>
    <button type="button" className="jv-list-row jv-secret-row" aria-expanded={open} aria-controls={details} onClick={onToggle}>
      <span className="jv-row-text"><strong>{machine.name}</strong><span className="jv-mono">{address}</span></span>
      <span className="jv-row-meta">{machine.botIds.length ? t("secrets.grantCount", { count: machine.botIds.length }) : t("secrets.notGranted")}</span>
      <ChevronDownIcon className="jv-row-chevron" aria-hidden="true"/>
    </button>
    {open && <div id={details} className="jv-list-row jv-static-row jv-secret-details">
      <BotGrants grantedIds={machine.botIds} bots={bots}
        onGrant={async (ids, granted) => { let saved = machine; for (const id of ids) saved = await api.grantMachine(machine.id, id, granted); onChanged(saved); }}/>
      <form className="jv-secret-edit" onSubmit={save} aria-label={machine.name}>
        <label className="jv-field"><span>{t("machines.name")}</span><Input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
        <label className="jv-field"><span>{t("machines.directory")}</span>
          <Input className="jv-mono" required maxLength={1000} spellCheck={false} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
        <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={!!busy || !edited || !name.trim()}>{t("common.save")}</Button></div>
      </form>
      <section className="jv-secret-grants" aria-label={t("machines.fingerprint")}>
        <div className="jv-secret-grants-head"><h4 className="jv-secret-heading">{t("machines.fingerprint")}</h4>
          {check?.changed ? <Button type="button" variant="outline" size="sm" disabled={!!busy}
            onClick={() => void act("trust", async () => { onChanged(await api.trustMachine(machine.id, check.hostKeys.fingerprints)); setCheck(null); })}>{t("machines.trust")}</Button>
            : <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => void act("check", async () => {
              const result = await api.checkMachine(machine.id); setCheck(result); onChanged(result.machine); })}>
              {t(busy === "check" ? "machines.checking" : "machines.check")}</Button>}</div>
        <div className="jv-machine-prints">{(check?.changed ? check.hostKeys.fingerprints : machine.fingerprints).map(print => <code key={print} data-new={check?.changed || undefined}>{print}</code>)}</div>
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
              <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => void act("key", async () => {
                const result = await api.checkMachine(machine.id); setCheck(result); onChanged(result.machine);
                setLoginNote(t(result.machine.login === "key" ? "machines.usingKey" : "machines.stillPassword"));
              })}>{t("machines.useKey")}</Button>
              <Button type="submit" variant="outline" size="sm" disabled={!!busy || !password}>{t("machines.updatePassword")}</Button>
            </div>
          </form>
        </>}
        {loginNote && <p className="jv-hint">{loginNote}</p>}
      </section>
      {!confirming ? <div className="jv-secret-actions jv-secret-danger"><Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirming("delete")}>{t("machines.delete")}</Button></div>
        : <div className="jv-secret-confirm" role="group" aria-label={t(confirming === "force" ? "machines.forceTitle" : "machines.deleteTitle", { name: machine.name })}>
          <strong>{t(confirming === "force" ? "machines.forceTitle" : "machines.deleteTitle", { name: machine.name })}</strong>
          <p>{confirming === "force" ? t("machines.forceBody", { comment: `jarvy-${machine.id}` }) : t("machines.deleteBody")}</p>
          <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { setConfirming(null); setError(null); }}>{t("common.cancel")}</Button>
            <Button type="button" className="jv-primary" size="sm" disabled={!!busy} onClick={() => remove(confirming === "force")}>
              {t(confirming === "force" ? "machines.forceConfirm" : "machines.deleteConfirm")}</Button></div>
        </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}
  </>;
}
