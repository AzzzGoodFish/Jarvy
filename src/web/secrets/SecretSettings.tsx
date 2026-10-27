import { useEffect, useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { api, type Bot, type Secret } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorText } from "../errors";
import { useAction } from "../action";
import { SecretItem } from "./SecretItem";
import { SecretInput } from "./SecretInput";
import "../styles/secrets.css";

const byName = (a: Secret, b: Secret) => a.name.localeCompare(b.name);

/** Settings → Secrets (A52): tokens and passwords the owner keeps for Bots, each granted to the Bots that may use it.
 * Values go in once and never come back to the page; the master key's place is shown so it can be backed up. */
export function SecretSettings() {
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [keyLocation, setKeyLocation] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.secrets().then(view => { setSecrets([...view.secrets].sort(byName)); setKeyLocation(view.keyLocation); }).catch(reason => setError(errorText(reason)));
    void api.bots().then(result => setBots(result.bots)).catch(() => setBots([]));
  }, []);
  const changed = (secret: Secret) => setSecrets(list => list && list.map(item => item.id === secret.id ? secret : item));
  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.secrets")}</h2>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("secrets.add")}</Button>}</header>
    {adding && <SecretForm onCancel={() => setAdding(false)} onSaved={secret => {
      setAdding(false); setSecrets(list => [...(list ?? []), secret].sort(byName)); setOpen(secret.id);
    }}/>}
    {secrets && !secrets.length && !adding && <div className="jv-empty"><strong>{t("secrets.empty")}</strong></div>}
    {secrets && secrets.length > 0 && <section className="jv-section" aria-label={t("settings.secrets")}><div className="jv-list">
      {secrets.map(secret => <SecretItem key={secret.id} secret={secret} bots={bots} open={open === secret.id}
        onToggle={() => setOpen(open === secret.id ? null : secret.id)} onChanged={changed}
        onDeleted={() => { setOpen(null); setSecrets(list => list && list.filter(item => item.id !== secret.id)); }}/>)}
    </div></section>}
    {keyLocation && <section className="jv-section" aria-labelledby="secrets-key"><h3 id="secrets-key" className="jv-section-title">{t("secrets.masterKey")}</h3>
      <div className="jv-list"><div className="jv-list-row jv-static-row jv-secret-key">
        <span className="jv-row-text"><strong>{t("secrets.keyFile")}</strong><code>{keyLocation}</code><span>{t("secrets.keyHint")}</span></span>
      </div></div></section>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

/** A new secret: name, an optional description and the value, hidden while typed unless shown. */
function SecretForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (secret: Secret) => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [value, setValue] = useState("");
  const [visible, setVisible] = useState(false), { busy, error, run } = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await run("add", async () => onSaved(await api.createSecret({ name: name.trim(), description: description.trim(), value })));
  };
  return <form className="jv-panel jv-secret-form" onSubmit={event => void submit(event)} aria-label={t("secrets.add")}>
    <label className="jv-field"><span>{t("secrets.name")}</span>
      <Input className="jv-mono" required autoFocus maxLength={64} placeholder="GITHUB_TOKEN" value={name} onChange={event => setName(event.target.value.toUpperCase())}/></label>
    <label className="jv-field"><span>{t("secrets.description")}</span>
      <Input maxLength={200} placeholder={t("secrets.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
    <label className="jv-field"><span>{t("secrets.value")}</span><SecretInput value={value} visible={visible} onChange={setValue} onVisible={setVisible} required/></label>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions"><Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !name.trim() || !value}>{t("common.save")}</Button></div>
  </form>;
}
