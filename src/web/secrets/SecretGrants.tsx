import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Secret } from "../../contract/secrets";
import { t } from "../i18n";
import { BotAvatar } from "../avatar/BotAvatar";
import { Grants } from "./Grants";

/** The Bots that can use a secret (A52). */
export function SecretGrants({ secret, bots, onChanged }: { secret: Secret; bots: Bot[]; onChanged: (secret: Secret) => void }) {
  return <BotGrants grantedIds={secret.grants.map(grant => grant.botId)} onceIds={new Set(secret.grants.filter(grant => grant.scope === "once").map(grant => grant.botId))}
    bots={bots} onGrant={async (ids, granted) => { let saved = secret; for (const id of ids) saved = await api.grantSecret(secret.id, id, granted); onChanged(saved); }}/>;
}

/** The Bots that can use something the owner keeps (a secret, an SSH machine), in Settings. */
export function BotGrants({ grantedIds, onceIds, bots, onGrant }: { grantedIds: string[]; onceIds?: Set<string>; bots: Bot[]; onGrant: (botIds: string[], granted: boolean) => Promise<void> }) {
  const once = onceIds ?? new Set<string>();
  return <Grants grantedIds={grantedIds} onGrant={onGrant}
    items={bots.map(bot => ({ id: bot.id, name: bot.name, once: once.has(bot.id), icon: <BotAvatar color={bot.color} mood={bot.mood} size={20} crown={bot.agent}/> }))}
    texts={{ heading: t("secrets.grants"), add: t("secrets.addBots"), search: t("secrets.searchBots"), none: t("secrets.noGrants"), nothing: t("secrets.noBots"),
      noMatch: t("secrets.noMatch"), all: t("secrets.allGranted") }}/>;
}
