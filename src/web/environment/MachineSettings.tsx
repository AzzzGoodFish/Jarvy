import { useEffect, useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { api, type Bot, type HostKeys, type SshMachine } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorText } from "../errors";
import { SecretInput } from "../secrets/SecretInput";
import { MachineItem } from "./MachineItem";
import "../styles/secrets.css";
import "../styles/machines.css";

/** Settings → Environments (A57): machines added over SSH, each granted to the Bots that may switch to it. Adding one
 * takes two steps: where it is, then its fingerprint to check and the password, used once to install Jarvy's key. */
export function MachineSettings() {
  const [machines, setMachines] = useState<SshMachine[] | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.machines().then(view => setMachines(view.machines)).catch(reason => setError(errorText(reason)));
    void api.bots().then(result => setBots(result.bots)).catch(() => setBots([]));
  }, []);
  const changed = (machine: SshMachine) => setMachines(list => list && list.map(item => item.id === machine.id ? machine : item));
  return <div className="jv-page">
    <header className="jv-page-header"><div><h2>{t("settings.machines")}</h2><p>{t("machines.intro")}</p></div>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("machines.add")}</Button>}</header>
    {adding && <MachineForm onCancel={() => setAdding(false)} onSaved={machine => {
      setAdding(false); setMachines(list => [...(list ?? []), machine]); setOpen(machine.id);
    }}/>}
    {machines && !machines.length && !adding && <div className="jv-empty"><strong>{t("machines.empty")}</strong><span>{t("machines.emptyHint")}</span></div>}
    {machines && machines.length > 0 && <section className="jv-section" aria-label={t("settings.machines")}><div className="jv-list">
      {machines.map(machine => <MachineItem key={machine.id} machine={machine} bots={bots} open={open === machine.id}
        onToggle={() => setOpen(open === machine.id ? null : machine.id)} onChanged={changed}
        onDeleted={() => { setOpen(null); setMachines(list => list && list.filter(item => item.id !== machine.id)); }}/>)}
    </div></section>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

/** A new machine: where it is first; then, once scanned, the fingerprint to check and the password. */
function MachineForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (machine: SshMachine) => void }) {
  const [host, setHost] = useState(""), [port, setPort] = useState("22"), [user, setUser] = useState(""), [name, setName] = useState(""), [directory, setDirectory] = useState("");
  const [hostKeys, setHostKeys] = useState<HostKeys | null>(null);
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const address = { host: host.trim(), port: Number(port) || 22, user: user.trim() };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hostKeys) void run(async () => setHostKeys(await api.scanMachine(address)));
    else void run(async () => onSaved(await api.addMachine({ ...address, name: name.trim(), directory: directory.trim(), password, hostKeys })));
  };
  const where = address.user && address.host ? `${address.user}@${address.host}` : "";
  return <form className="jv-panel jv-machine-form" autoComplete="off" onSubmit={submit} aria-label={t("machines.add")} aria-busy={busy || undefined}>
    {!hostKeys ? <div className="jv-machine-fields">
      <label className="jv-field jv-machine-host"><span>{t("machines.host")}</span>
        <Input required autoFocus maxLength={253} spellCheck={false} placeholder={t("machines.hostPlaceholder")} value={host} onChange={event => setHost(event.target.value)}/></label>
      <label className="jv-field jv-machine-port"><span>{t("machines.port")}</span>
        <Input required inputMode="numeric" maxLength={5} value={port} onChange={event => setPort(event.target.value.replace(/\D/g, ""))}/></label>
      <label className="jv-field"><span>{t("machines.user")}</span>
        <Input required maxLength={64} spellCheck={false} autoCapitalize="off" value={user} onChange={event => setUser(event.target.value)}/></label>
      <label className="jv-field"><span>{t("machines.name")}</span>
        <Input maxLength={40} placeholder={where} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field jv-machine-wide"><span>{t("machines.directory")}</span>
        <Input className="jv-mono" maxLength={1000} spellCheck={false} placeholder={t("machines.directoryPlaceholder")} value={directory} onChange={event => setDirectory(event.target.value)}/></label>
    </div> : <>
      <p className="jv-machine-where">{name.trim() && <strong>{name.trim()}</strong>}<code>{address.user}@{address.host}{address.port === 22 ? "" : `:${address.port}`}</code></p>
      <div className="jv-field"><span>{t("machines.fingerprint")}</span>
        <div className="jv-machine-prints">{hostKeys.fingerprints.map(print => <code key={print}>{print}</code>)}</div>
        <span className="jv-field-hint">{t("machines.fingerprintHint")}</span></div>
      <label className="jv-field"><span>{t("machines.password")}</span>
        <SecretInput value={password} visible={visible} onChange={setPassword} onVisible={setVisible} required warnShort={false}/>
        <span className="jv-field-hint">{t("machines.passwordHint")}</span></label>
    </>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (hostKeys) { setHostKeys(null); setPassword(""); setError(null); } else onCancel(); }}>{t(hostKeys ? "machines.back" : "common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !address.host || !address.user || (!!hostKeys && !password)}>
        {t(hostKeys ? (busy ? "machines.connecting" : "machines.connect") : busy ? "machines.scanning" : "machines.next")}</Button>
    </div>
  </form>;
}
