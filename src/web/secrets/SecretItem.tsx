import { useEffect, useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, UserIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Secret, type SecretCategory, type SecretUse } from "../../contract/secrets";
import { formatDate, t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAction } from "../action";
import { SecretInput } from "./SecretInput";
import { SecretGrants } from "./SecretGrants";
import { SettingsItem } from "./SettingsItem";
import {
  SecretCategoryIcon, SecretCategoryPicker, safeExternalUrl, secretCategoryLabel, secretPlaceholders, secretSummary,
} from "./category";

const when = (at: number) => formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One secret in Settings → Secrets: its row (category icon + mono name + associations), and when open its details —
 * fingerprint, associated URL/username chips, granted Bots, edit form, recent uses, and in-place delete confirmation. */
export function SecretItem({ secret, bots, open, onToggle, onChanged, onDeleted }: {
  secret: Secret; bots: Bot[]; open: boolean; onToggle: () => void; onChanged: (secret: Secret) => void; onDeleted: () => void;
}) {
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [category, setCategory] = useState<SecretCategory>(secret.category);
  const [url, setUrl] = useState(secret.url);
  const [username, setUsername] = useState(secret.username);
  const [description, setDescription] = useState(secret.description);
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false);
  const [copiedUser, setCopiedUser] = useState(false);
  const [confirming, setConfirming] = useState(false), { busy, error, run: act } = useAction<"save" | "delete">();

  useEffect(() => {
    setCategory(secret.category);
    setUrl(secret.url);
    setUsername(secret.username);
    setDescription(secret.description);
  }, [secret.category, secret.url, secret.username, secret.description]);

  useEffect(() => { if (open) void api.secretUses(secret.id).then(result => setUses(result.uses)).catch(() => setUses([])); }, [open, secret.id, secret.uses]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    void act("save", async () => {
      onChanged(await api.updateSecret(secret.id, {
        category, url: url.trim(), username: username.trim(), description: description.trim(), ...(value ? { value } : {}),
      }));
      setValue("");
      setVisible(false);
    });
  };

  const copyUsername = () => {
    if (!secret.username) return;
    void navigator.clipboard?.writeText(secret.username).then(() => {
      setCopiedUser(true);
      window.setTimeout(() => setCopiedUser(false), 1500);
    });
  };

  const granted = new Set(secret.grants.map(grant => grant.botId));
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? t("secrets.deletedBot");
  const changedForm = category !== secret.category
    || url.trim() !== secret.url
    || username.trim() !== secret.username
    || description.trim() !== secret.description
    || !!value;
  const summary = secretSummary(secret);
  const externalHref = safeExternalUrl(secret.url);
  const hints = secretPlaceholders(category);

  return <SettingsItem id={`secret-${secret.id}`} open={open} onToggle={onToggle} busy={busy} error={error}
    text={<>
      <span className="jv-secret-title-line">
        <SecretCategoryIcon category={secret.category} className="jv-secret-row-icon"/>
        <strong className="jv-mono">{secret.name}</strong>
        <span className="jv-secret-cat-tag">{secretCategoryLabel(secret.category)}</span>
      </span>
      <span>{summary || t("secrets.noDescription")}</span>
    </>}
    meta={!secret.readable ? <span className="jv-status" data-busy="">{t("secrets.unreadable")}</span>
      : <span className="jv-row-meta">{granted.size ? t("secrets.grantCount", { count: granted.size }) : t("secrets.notGranted")}</span>}
    remove={t("secrets.delete")} confirming={confirming ? { title: t("secrets.deleteTitle", { name: secret.name }), body: t("secrets.deleteBody"), confirm: t("secrets.deleteConfirm") } : null}
    onAskRemove={() => setConfirming(true)} onCancel={() => setConfirming(false)}
    onConfirm={() => void act("delete", async () => { await api.deleteSecret(secret.id); onDeleted(); })}>
    <p className="jv-secret-meta">{t("secrets.fingerprint")} <code>{secret.fingerprint}</code> · {t("secrets.updated", { time: when(secret.updatedAt) })} · {secret.uses ? t("secrets.usedCount", { count: secret.uses }) : t("secrets.neverUsed")}</p>
    {(secret.url || secret.username) && <div className="jv-secret-assoc">
      {secret.url && (externalHref
        ? <a className="jv-secret-chip" href={externalHref} target="_blank" rel="noopener noreferrer" title={secret.url}>
            <GlobeIcon aria-hidden="true"/><span>{secret.url}</span><ExternalLinkIcon className="jv-secret-chip-tail" aria-hidden="true"/>
          </a>
        : <span className="jv-secret-chip" title={secret.url}><GlobeIcon aria-hidden="true"/><span>{secret.url}</span></span>)}
      {secret.username && <button type="button" className="jv-secret-chip" onClick={copyUsername} title={t("secrets.copyUsername")}>
        <UserIcon aria-hidden="true"/><span>{secret.username}</span>
        {copiedUser ? <CheckIcon className="jv-secret-chip-tail" aria-hidden="true"/> : <CopyIcon className="jv-secret-chip-tail" aria-hidden="true"/>}
      </button>}
    </div>}
    {!secret.readable && <p className="jv-note-error">{t("secrets.unreadableHint")}</p>}
    <SecretGrants secret={secret} bots={bots} onChanged={onChanged}/>
    <form className="jv-secret-edit" onSubmit={save} aria-label={t("secrets.edit")}>
      <div className="jv-field jv-secret-edit-full"><span>{t("secrets.category")}</span>
        <SecretCategoryPicker value={category} onChange={setCategory} disabled={busy} compact/></div>
      <label className="jv-field"><span>{t("secrets.url")}</span>
        <Input maxLength={300} placeholder={hints.url} value={url} onChange={event => setUrl(event.target.value)}/></label>
      <label className="jv-field"><span>{t("secrets.username")}</span>
        <Input maxLength={160} placeholder={hints.username} value={username} onChange={event => setUsername(event.target.value)}/></label>
      <label className="jv-field"><span>{t("secrets.description")}</span>
        <Input maxLength={200} placeholder={t("secrets.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <label className="jv-field"><span>{t("secrets.newValue")}</span>
        <SecretInput value={value} visible={visible} onChange={setValue} onVisible={setVisible} placeholder={t("secrets.newValuePlaceholder")}/></label>
      <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !changedForm}>{t("common.save")}</Button></div>
    </form>
    <h4 className="jv-secret-heading">{t("secrets.uses")}</h4>
    {uses && uses.length ? <ul className="jv-secret-uses">{uses.map(use => <li key={use.id}>
      <span>{botName(use.botId)} · {when(use.at)} · {t(use.how === "ssh_sign" ? "secrets.useSsh" : "secrets.useCommand")}</span>
      {use.detail && <code>{use.detail}</code>}</li>)}</ul> : <p className="jv-hint">{t("secrets.noUses")}</p>}
  </SettingsItem>;
}
