import { useEffect, useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, LockIcon } from "lucide-react";
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
  SecretFieldsEditor, fieldsDraftReady, remapDraftCategory, serializeFieldsDraft, toFieldsDraft, type SecretFieldsDraft,
} from "./SecretFieldsEditor";
import {
  SecretCategoryIcon, SecretCategoryPicker, fieldDisplayLabel, safeExternalUrl, secretCategoryLabel,
  secretPrimaryLabel, secretSummary,
} from "./category";

const when = (at: number) => formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One secret in Settings → Secrets: category icon + mono name + structured summary, and when open its details —
 * fingerprint, public/secret field chips, granted Bots, template + custom fields edit form, recent uses, and delete. */
export function SecretItem({ secret, bots, open, onToggle, onChanged, onDeleted }: {
  secret: Secret; bots: Bot[]; open: boolean; onToggle: () => void; onChanged: (secret: Secret) => void; onDeleted: () => void;
}) {
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [category, setCategory] = useState<SecretCategory>(secret.category);
  const [fieldsDraft, setFieldsDraft] = useState<SecretFieldsDraft>(() => toFieldsDraft(secret.category, secret.fields, true));
  const [description, setDescription] = useState(secret.description);
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false), { busy, error, run: act } = useAction<"save" | "delete">();

  useEffect(() => {
    setCategory(secret.category);
    setFieldsDraft(toFieldsDraft(secret.category, secret.fields, true));
    setDescription(secret.description);
  }, [secret.category, secret.fields, secret.description]);

  useEffect(() => { if (open) void api.secretUses(secret.id).then(result => setUses(result.uses)).catch(() => setUses([])); }, [open, secret.id, secret.uses]);

  const changeCategory = (next: SecretCategory) => {
    setFieldsDraft(prev => remapDraftCategory(category, next, prev));
    setCategory(next);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void act("save", async () => {
      onChanged(await api.updateSecret(secret.id, {
        category,
        fields: serializeFieldsDraft(category, fieldsDraft),
        description: description.trim(),
        ...(value ? { value } : {}),
      }));
      setValue("");
      setVisible(false);
    });
  };

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(cur => cur === key ? null : cur), 1500);
    });
  };

  const granted = new Set(secret.grants.map(grant => grant.botId));
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? t("secrets.deletedBot");
  const serializedNow = JSON.stringify(serializeFieldsDraft(category, fieldsDraft));
  const serializedSaved = JSON.stringify(serializeFieldsDraft(secret.category, toFieldsDraft(secret.category, secret.fields, true)));
  const changedForm = category !== secret.category
    || serializedNow !== serializedSaved
    || description.trim() !== secret.description
    || !!value;
  const summary = secretSummary(secret);

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
    {secret.fields.length > 0 && <div className="jv-secret-assoc">
      {secret.fields.map(field => {
        if (field.secret) {
          const ref = `{{secret:${secret.name}.${field.key}}}`;
          return <button key={field.key} type="button" className="jv-secret-chip jv-secret-chip-locked"
            onClick={() => copyText(`s:${field.key}`, ref)} title={t("secrets.copyPlaceholder")}>
            <LockIcon aria-hidden="true"/>
            <span className="jv-mono">{field.key}</span>
            {field.fingerprint && <code className="jv-secret-chip-fp">{field.fingerprint}</code>}
            {copiedKey === `s:${field.key}` ? <CheckIcon className="jv-secret-chip-tail" aria-hidden="true"/> : <CopyIcon className="jv-secret-chip-tail" aria-hidden="true"/>}
          </button>;
        }
        const val = field.value ?? "";
        const href = safeExternalUrl(val);
        const label = fieldDisplayLabel(field);
        if (href) {
          return <a key={field.key} className="jv-secret-chip" href={href} target="_blank" rel="noopener noreferrer" title={val}>
            <GlobeIcon aria-hidden="true"/><span>{val}</span><ExternalLinkIcon className="jv-secret-chip-tail" aria-hidden="true"/>
          </a>;
        }
        return <button key={field.key} type="button" className="jv-secret-chip" onClick={() => copyText(`p:${field.key}`, val)} title={t("secrets.copyField")}>
          <span className="jv-secret-chip-key">{label}</span>
          <span>{val}</span>
          {copiedKey === `p:${field.key}` ? <CheckIcon className="jv-secret-chip-tail" aria-hidden="true"/> : <CopyIcon className="jv-secret-chip-tail" aria-hidden="true"/>}
        </button>;
      })}
    </div>}
    {!secret.readable && <p className="jv-note-error">{t("secrets.unreadableHint")}</p>}
    <SecretGrants secret={secret} bots={bots} onChanged={onChanged}/>
    <form className="jv-secret-edit" onSubmit={save} aria-label={t("secrets.edit")}>
      <div className="jv-field jv-secret-edit-full"><span>{t("secrets.category")}</span>
        <SecretCategoryPicker value={category} onChange={changeCategory} disabled={busy} compact/></div>
      <div className="jv-secret-edit-full">
        <SecretFieldsEditor category={category} draft={fieldsDraft} onChange={setFieldsDraft} disabled={busy} compact/>
      </div>
      <label className="jv-field"><span>{t("secrets.description")}</span>
        <Input maxLength={200} placeholder={t("secrets.descriptionPlaceholder")} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <label className="jv-field"><span>{t("secrets.newPrimary", { label: secretPrimaryLabel(category) })}</span>
        <SecretInput value={value} visible={visible} onChange={setValue} onVisible={setVisible} placeholder={t("secrets.newValuePlaceholder")}/></label>
      <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy || !changedForm || !fieldsDraftReady(fieldsDraft)}>{t("common.save")}</Button></div>
    </form>
    <h4 className="jv-secret-heading">{t("secrets.uses")}</h4>
    {uses && uses.length ? <ul className="jv-secret-uses">{uses.map(use => <li key={use.id}>
      <span>{botName(use.botId)} · {when(use.at)} · {t(use.how === "ssh_sign" ? "secrets.useSsh" : "secrets.useCommand")}</span>
      {use.detail && <code>{use.detail}</code>}</li>)}</ul> : <p className="jv-hint">{t("secrets.noUses")}</p>}
  </SettingsItem>;
}
