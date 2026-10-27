import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Secret, type SecretUse } from "../../contract/secrets";
import { formatDate, t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAction } from "../action";
import { SecretInput } from "./SecretInput";
import { SecretGrants } from "./SecretGrants";
import { SettingsItem } from "./SettingsItem";

const when = (at: number) => formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One secret in Settings → Secrets: its row, and when open its details — fingerprint and use, the Bots that may use
 * it (SecretGrants), a new description or value, recent uses, and deleting it after confirming in place (Settings is a dialog). */
export function SecretItem({ secret, bots, open, onToggle, onChanged, onDeleted }: {
  secret: Secret; bots: Bot[]; open: boolean; onToggle: () => void; onChanged: (secret: Secret) => void; onDeleted: () => void;
}) {
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [description, setDescription] = useState(secret.description), [value, setValue] = useState(""), [visible, setVisible] = useState(false);
  const [confirming, setConfirming] = useState(false), { busy, error, run: act } = useAction<"save" | "delete">();
  useEffect(() => { if (open) void api.secretUses(secret.id).then(result => setUses(result.uses)).catch(() => setUses([])); }, [open, secret.id, secret.uses]);
  const save = (event: FormEvent) => { event.preventDefault(); void act("save", async () => {
    onChanged(await api.updateSecret(secret.id, { description: description.trim(), ...(value ? { value } : {}) })); setValue(""); setVisible(false);
  }); };
  const granted = new Set(secret.grants.map(grant => grant.botId));
  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? t("secrets.deletedBot");
  const changedForm = description.trim() !== secret.description || !!value;
  return <SettingsItem id={`secret-${secret.id}`} open={open} onToggle={onToggle} busy={busy} error={error}
    text={<><strong className="jv-mono">{secret.name}</strong><span>{secret.description || t("secrets.noDescription")}</span></>}
    meta={!secret.readable ? <span className="jv-status" data-busy="">{t("secrets.unreadable")}</span>
      : <span className="jv-row-meta">{granted.size ? t("secrets.grantCount", { count: granted.size }) : t("secrets.notGranted")}</span>}
    remove={t("secrets.delete")} confirming={confirming ? { title: t("secrets.deleteTitle", { name: secret.name }), body: t("secrets.deleteBody"), confirm: t("secrets.deleteConfirm") } : null}
    onAskRemove={() => setConfirming(true)} onCancel={() => setConfirming(false)}
    onConfirm={() => void act("delete", async () => { await api.deleteSecret(secret.id); onDeleted(); })}>
    <p className="jv-secret-meta">{t("secrets.fingerprint")} <code>{secret.fingerprint}</code> · {t("secrets.updated", { time: when(secret.updatedAt) })} · {secret.uses ? t("secrets.usedCount", { count: secret.uses }) : t("secrets.neverUsed")}</p>
    {!secret.readable && <p className="jv-note-error">{t("secrets.unreadableHint")}</p>}
    <SecretGrants secret={secret} bots={bots} onChanged={onChanged}/>
    <form className="jv-secret-edit" onSubmit={save} aria-label={t("secrets.edit")}>
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
