import { useEffect, useState, type FormEvent } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { SECRET_CATEGORIES, type Secret, type SecretCategory } from "../../contract/secrets";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { errorText } from "../errors";
import { useAction } from "../action";
import { SecretItem } from "./SecretItem";
import { SecretInput } from "./SecretInput";
import {
  SecretFieldsEditor, fieldsDraftReady, remapDraftCategory, serializeFieldsDraft, type SecretFieldsDraft,
} from "./SecretFieldsEditor";
import {
  SecretCategoryPicker, matchesSecretQuery, secretCategoryLabel, secretNamePlaceholder, secretPrimaryLabel,
} from "./category";
import "../styles/secrets.css";

const byName = (a: Secret, b: Secret) => a.name.localeCompare(b.name);

/** Settings → Secrets (A52): typed secrets with built-in category templates and extensible public/secret fields.
 * Secret values go in once and never come back to the page; the master key's place is shown so it can be backed up. */
export function SecretSettings() {
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [keyLocation, setKeyLocation] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | SecretCategory>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.secrets().then(view => {
      setSecrets([...view.secrets].filter(s => s.kind === "value").sort(byName));
      setKeyLocation(view.keyLocation);
    }).catch(reason => setError(errorText(reason)));
    void api.bots().then(result => setBots(result.bots)).catch(() => setBots([]));
  }, []);

  const changed = (secret: Secret) => setSecrets(list => list && list.map(item => item.id === secret.id ? secret : item));
  const visibleSecrets = (secrets ?? []).filter(secret =>
    (categoryFilter === "all" || secret.category === categoryFilter) && matchesSecretQuery(secret, query),
  );

  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.secrets")}</h2>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("secrets.add")}</Button>}</header>
    {adding && <SecretForm onCancel={() => setAdding(false)} onSaved={secret => {
      setAdding(false);
      setCategoryFilter("all");
      setQuery("");
      setSecrets(list => [...(list ?? []), secret].sort(byName));
      setOpen(secret.id);
    }}/>}
    {secrets && !secrets.length && !adding && <div className="jv-empty"><strong>{t("secrets.empty")}</strong></div>}
    {secrets && secrets.length > 0 && <section className="jv-section" aria-label={t("settings.secrets")}>
      <div className="jv-secret-toolbar">
        <div className="jv-secret-filters" role="tablist" aria-label={t("secrets.category")}>
          <button type="button" role="tab" aria-selected={categoryFilter === "all"} className="jv-secret-filter-pill"
            onClick={() => setCategoryFilter("all")}>
            <span>{t("secrets.cat.all")}</span>
            <span className="jv-secret-filter-count">{secrets.length}</span>
          </button>
          {SECRET_CATEGORIES.map(category => {
            const count = secrets.filter(item => item.category === category).length;
            if (count === 0 && categoryFilter !== category) return null;
            return <button key={category} type="button" role="tab" aria-selected={categoryFilter === category}
              className="jv-secret-filter-pill" onClick={() => setCategoryFilter(category)}>
              <span>{secretCategoryLabel(category)}</span>
              <span className="jv-secret-filter-count">{count}</span>
            </button>;
          })}
        </div>
        <label className="jv-search jv-secret-search"><SearchIcon aria-hidden="true"/>
          <input type="search" value={query} placeholder={t("secrets.searchPlaceholder")} aria-label={t("secrets.searchPlaceholder")}
            onChange={event => setQuery(event.target.value)}/>
        </label>
      </div>
      {visibleSecrets.length > 0
        ? <div className="jv-list">
            {visibleSecrets.map(secret => <SecretItem key={secret.id} secret={secret} bots={bots} open={open === secret.id}
              onToggle={() => setOpen(open === secret.id ? null : secret.id)} onChanged={changed}
              onDeleted={() => { setOpen(null); setSecrets(list => list && list.filter(item => item.id !== secret.id)); }}/>)}
          </div>
        : <p className="jv-hint jv-secret-no-match">{t("secrets.noMatchingSecrets")}</p>}
    </section>}
    {keyLocation && <section className="jv-section" aria-labelledby="secrets-key"><h3 id="secrets-key" className="jv-section-title">{t("secrets.masterKey")}</h3>
      <div className="jv-list"><div className="jv-list-row jv-static-row jv-secret-key">
        <span className="jv-row-text"><strong>{t("secrets.keyFile")}</strong><code>{keyLocation}</code><span>{t("secrets.keyHint")}</span></span>
      </div></div></section>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

/** A new secret: category template, name, template/extensible fields, optional description, and the primary secret value. */
function SecretForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (secret: Secret) => void }) {
  const [category, setCategory] = useState<SecretCategory>("api_key");
  const [name, setName] = useState("");
  const [fieldsDraft, setFieldsDraft] = useState<SecretFieldsDraft>({ builtIn: {}, custom: [] });
  const [description, setDescription] = useState(""), [value, setValue] = useState("");
  const [visible, setVisible] = useState(false), { busy, error, run } = useAction();

  const changeCategory = (next: SecretCategory) => {
    setFieldsDraft(prev => remapDraftCategory(category, next, prev));
    setCategory(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await run("add", async () => onSaved(await api.createSecret({
      name: name.trim(),
      category,
      fields: serializeFieldsDraft(category, fieldsDraft),
      description: description.trim(),
      value,
    })));
  };

  const ready = Boolean(name.trim() && value && fieldsDraftReady(fieldsDraft));

  return <form className="jv-panel jv-secret-form" onSubmit={event => void submit(event)} aria-label={t("secrets.add")}>
    <div className="jv-field"><span>{t("secrets.category")}</span>
      <SecretCategoryPicker value={category} onChange={changeCategory} disabled={busy}/></div>
    <label className="jv-field"><span>{t("secrets.name")}</span>
      <Input className="jv-mono" required autoFocus maxLength={64} placeholder={secretNamePlaceholder(category)}
        value={name} onChange={event => setName(event.target.value.toUpperCase())}/></label>
    <SecretFieldsEditor category={category} draft={fieldsDraft} onChange={setFieldsDraft} disabled={busy}/>
    <label className="jv-field"><span>{t("secrets.description")}</span>
      <Input maxLength={200} placeholder={t("secrets.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
    <label className="jv-field"><span>{secretPrimaryLabel(category)}</span>
      <SecretInput value={value} visible={visible} onChange={setValue} onVisible={setVisible} required/></label>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions"><Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !ready}>{t("common.save")}</Button></div>
  </form>;
}
