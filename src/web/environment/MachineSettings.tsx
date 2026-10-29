import { useEffect, useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { ApiError, api } from "../api";
import { type Bot } from "../../contract/bots";
import { type HostKeys, type SshMachine } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { errorText } from "../errors";
import { useAction } from "../action";
import { SecretInput } from "../secrets/SecretInput";
import { MachineItem } from "./MachineItem";
import { MachineKeyLine, usePreparedKey, type MachineLogin } from "./MachineKey";
import "../styles/secrets.css";
import "../styles/machines.css";

/** Settings → Environments (A57, A59): machines added over SSH, each granted to the Bots that may switch to it. Adding
 * one takes two steps: where it is, then its fingerprint to check and how Jarvy gets in — the password, which installs
 * Jarvy's key, or Jarvy's public key that the owner adds to the machine themselves. The computer running Jarvy is
 * added the same way when Bots should work there (A67). */
export function MachineSettings({ adding: startAdding = false }: { adding?: boolean }) {
  const [machines, setMachines] = useState<SshMachine[] | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(startAdding);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.machines().then(view => setMachines(view.machines)).catch(reason => setError(errorText(reason)));
    void api.bots().then(result => setBots(result.bots)).catch(() => setBots([]));
  }, []);
  const changed = (machine: SshMachine) => setMachines(list => list && list.map(item => item.id === machine.id ? machine : item));
  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.machines")}</h2>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("machines.add")}</Button>}</header>
    {adding && <MachineForm onCancel={() => setAdding(false)} onSaved={machine => {
      setAdding(false); setMachines(list => [...(list ?? []), machine]); setOpen(machine.id);
    }}/>}
    {machines && !machines.length && !adding && <div className="jv-empty"><strong>{t("machines.empty")}</strong></div>}
    {machines && machines.length > 0 && <section className="jv-section" aria-label={t("settings.machines")}><div className="jv-list">
      {machines.map(machine => <MachineItem key={machine.id} machine={machine} bots={bots} open={open === machine.id}
        onToggle={() => setOpen(open === machine.id ? null : machine.id)} onChanged={changed}
        onDeleted={() => { setOpen(null); setMachines(list => list && list.filter(item => item.id !== machine.id)); }}/>)}
    </div></section>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

/** A new machine: where it is first; then, once scanned, the fingerprint to check and the password or Jarvy's key. */
function MachineForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (machine: SshMachine) => void }) {
  const [host, setHost] = useState(""), [port, setPort] = useState("22"), [user, setUser] = useState(""), [name, setName] = useState(""), [directory, setDirectory] = useState(""), [description, setDescription] = useState("");
  const [hostKeys, setHostKeys] = useState<HostKeys | null>(null);
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), [login, setLogin] = useState<MachineLogin>("password");
  const { busy, error, setError, run: perform } = useAction();
  const prepared = usePreparedKey(!!hostKeys && login === "key");
  const address = { host: host.trim(), port: Number(port) || 22, user: user.trim() };
  const run = (work: () => Promise<void>) => perform("add", async () => {
    try { await work(); } catch (reason) { if (reason instanceof ApiError && reason.code === "ssh_key_expired") prepared.renew(); throw reason; }
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hostKeys) void run(async () => setHostKeys(await api.scanMachine(address)));
    else void run(async () => onSaved(await api.addMachine({ ...address, name: name.trim(), directory: directory.trim(), description: description.trim(), hostKeys,
      ...(login === "key" ? { keyId: prepared.key!.keyId } : { password }) })));
  };
  const where = address.user && address.host ? `${address.user}@${address.host}` : "";
  return <form className="jv-panel jv-machine-form" autoComplete="off" onSubmit={submit} aria-label={t("machines.add")} aria-busy={busy || undefined}>
    {!hostKeys ? <div className="jv-machine-fields">
      <div className="jv-machine-address">
        <label className="jv-field jv-machine-host"><span>{t("machines.host")}</span>
          <Input required autoFocus maxLength={253} spellCheck={false} placeholder={t("machines.hostPlaceholder")} value={host} onChange={event => setHost(event.target.value)}/></label>
        <label className="jv-field jv-machine-port"><span>{t("machines.port")}</span>
          <Input required inputMode="numeric" maxLength={5} value={port} onChange={event => setPort(event.target.value.replace(/\D/g, ""))}/></label>
      </div>
      <label className="jv-field"><span>{t("machines.user")}</span>
        <Input required maxLength={64} spellCheck={false} autoCapitalize="off" value={user} onChange={event => setUser(event.target.value)}/></label>
      <label className="jv-field"><span>{t("machines.name")}</span>
        <Input maxLength={40} placeholder={where} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field jv-machine-wide"><span>{t("machines.directory")}</span>
        <Input className="jv-mono" maxLength={1000} spellCheck={false} placeholder={t("machines.directoryPlaceholder")} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
      <label className="jv-field jv-machine-wide"><span>{t("machines.description")}</span>
        <Textarea maxLength={2000} rows={3} placeholder={t("machines.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
    </div> : <>
      <p className="jv-machine-where">{name.trim() && <strong>{name.trim()}</strong>}<code>{address.user}@{address.host}{address.port === 22 ? "" : `:${address.port}`}</code></p>
      <div className="jv-field"><span>{t("machines.fingerprint")}</span>
        <div className="jv-machine-prints">{hostKeys.fingerprints.map(print => <code key={print}>{print}</code>)}</div>
        <span className="jv-field-hint">{t("machines.fingerprintHint")}</span></div>
      <div className="jv-seg jv-machine-login" role="radiogroup" aria-label={t("machines.login")}>
        {(["password", "key"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={login === item} disabled={busy}
          onClick={() => { setLogin(item); setError(""); }}>{t(item === "password" ? "machines.byPassword" : "machines.byKey")}</button>)}
      </div>
      {login === "password" ? <label className="jv-field"><span>{t("machines.password")}</span>
        <SecretInput value={password} visible={visible} onChange={setPassword} onVisible={setVisible} required warnShort={false}/>
        <span className="jv-field-hint">{t("machines.passwordHint")}</span></label>
        : <div className="jv-field"><span>{t("machines.publicKey")}</span>
          {prepared.key ? <MachineKeyLine publicKey={prepared.key.publicKey}/> : prepared.error ? <p className="jv-note-error" role="alert">{prepared.error}</p> : <p className="jv-hint">…</p>}
          <span className="jv-field-hint">{t("machines.keyHint", { user: address.user })}</span></div>}
    </>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (hostKeys) { setHostKeys(null); setPassword(""); setError(""); } else onCancel(); }}>{t(hostKeys ? "machines.back" : "common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !address.host || !address.user || (!!hostKeys && (login === "key" ? !prepared.key : !password))}>
        {t(!hostKeys ? (busy ? "machines.scanning" : "machines.next") : login === "key" ? (busy ? "machines.verifying" : "machines.verify") : busy ? "machines.connecting" : "machines.connect")}</Button>
    </div>
  </form>;
}
