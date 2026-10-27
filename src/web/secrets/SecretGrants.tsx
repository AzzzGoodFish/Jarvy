import { useState } from "react";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Secret } from "../../contract/secrets";
import { t } from "../i18n";
import { BotAvatar } from "../avatar/BotAvatar";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAction } from "../action";

/** The Bots that can use a secret (A52). */
export function SecretGrants({ secret, bots, onChanged }: { secret: Secret; bots: Bot[]; onChanged: (secret: Secret) => void }) {
  return <BotGrants grantedIds={secret.grants.map(grant => grant.botId)} onceIds={new Set(secret.grants.filter(grant => grant.scope === "once").map(grant => grant.botId))}
    bots={bots} onGrant={async (ids, granted) => { let saved = secret; for (const id of ids) saved = await api.grantSecret(secret.id, id, granted); onChanged(saved); }}/>;
}

/** The Bots that can use something the owner keeps (a secret, an SSH machine), kept like a channel's members: a list
 * with remove, and Add opening a search to pick one or more. The picker opens in place, since Settings is itself a
 * dialog. Removing takes effect at once; it can be added back. */
export function BotGrants({ grantedIds, onceIds, bots, onGrant }: { grantedIds: string[]; onceIds?: Set<string>; bots: Bot[]; onGrant: (botIds: string[], granted: boolean) => Promise<void> }) {
  const [picking, setPicking] = useState(false), [query, setQuery] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run: perform } = useAction();
  const granted = grantedIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const once = onceIds ?? new Set<string>();
  const candidates = bots.filter(bot => !grantedIds.includes(bot.id));
  const shown = candidates.filter(bot => bot.name.toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setPicking(false); setQuery(""); setPicked([]); };
  const toggle = (id: string) => setPicked(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  const run = (action: () => Promise<void>) => perform("grant", action);
  const add = () => run(async () => { await onGrant(picked, true); close(); });
  return <section className="jv-secret-grants" aria-label={t("secrets.grants")}>
    <div className="jv-secret-grants-head"><h4 className="jv-secret-heading">{t("secrets.grants")}{granted.length > 0 && <span> · {granted.length}</span>}</h4>
      {!picking && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}><PlusIcon/>{t("secrets.addBots")}</Button>}</div>
    {granted.length > 0 ? <ul className="jv-secret-granted">{granted.map(bot => <li key={bot.id}>
      <BotAvatar color={bot.color} mood={bot.mood} size={24} crown={bot.agent}/><span className="jv-secret-bot-name">{bot.name}</span>
      {once.has(bot.id) && <span className="jv-secret-once">{t("secrets.onceTag")}</span>}
      <Button type="button" variant="ghost" size="icon-sm" className="jv-secret-revoke" disabled={busy} aria-label={t("secrets.revoke", { name: bot.name })}
        onClick={() => void run(() => onGrant([bot.id], false))}><XIcon/></Button>
    </li>)}</ul> : !picking && <p className="jv-hint">{t("secrets.noGrants")}</p>}
    {picking && <div className="jv-secret-picker">
      <Input type="search" autoFocus value={query} placeholder={t("secrets.searchBots")} aria-label={t("secrets.searchBots")} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (shown.length === 1) toggle(shown[0]!.id); } }}/>
      <div className="jv-secret-options" role="listbox" aria-multiselectable="true" aria-label={t("secrets.addBots")}>
        {shown.map(bot => <button key={bot.id} type="button" role="option" aria-selected={picked.includes(bot.id)} className="jv-secret-option" onClick={() => toggle(bot.id)}>
          <BotAvatar color={bot.color} mood={bot.mood} size={24} crown={bot.agent}/><span className="jv-secret-bot-name">{bot.name}</span>{picked.includes(bot.id) && <CheckIcon aria-hidden="true"/>}
        </button>)}
        {shown.length === 0 && <p className="jv-hint">{t(!bots.length ? "secrets.noBots" : candidates.length ? "secrets.noMatch" : "secrets.allGranted")}</p>}
      </div>
      <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={close}>{t("common.cancel")}</Button>
        <Button type="button" className="jv-primary" size="sm" disabled={busy || !picked.length} onClick={() => void add()}>{picked.length ? t("dialogs.addCount", { count: picked.length }) : t("common.add")}</Button></div>
    </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
