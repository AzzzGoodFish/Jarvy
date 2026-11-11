import { useEffect, useState } from "react";
import { KeyRoundIcon, PlusIcon, ServerIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type SshMachine } from "../../contract/environment";
import { type Secret } from "../../contract/secrets";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Grants } from "../secrets/Grants";
import { machineAddress } from "../environment/MachineDetail";

/** Bot info's 授权 tab: the owner's secrets (A52) and SSH machines (A57) this Bot may use, each removable at once, and
 * Add to pick more. The Bot sees all of them, granted or not, and asks for the rest on a card; this is where the owner
 * sees and changes what it has. The grants are the same ones Settings shows per secret and the Environments page per machine. */
export function BotAccess({ bot, onSaved, onManageSecrets, onAddMachine }: {
  bot: Bot; onSaved: (bot: Bot) => void; onManageSecrets: () => void; onAddMachine: () => void;
}) {
  const [secrets, setSecrets] = useState<Secret[] | null>(null), [machines, setMachines] = useState<SshMachine[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.secrets(), api.machines()]).then(([kept, added]) => {
      if (alive) { setSecrets(kept.secrets.filter(secret => secret.kind === "value")); setMachines(added.machines); }
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [bot.id]);
  if (failed) return <p className="jv-note-error" role="alert">{t("access.loadFailed")}</p>;
  if (!secrets || !machines) return null;
  const mine = (secret: Secret) => secret.grants.find(grant => grant.botId === bot.id);
  return <section className="jv-section jv-access" aria-label={t("bot.tab.access")}>
    <Grants rows grantedIds={secrets.filter(mine).map(secret => secret.id)}
      items={secrets.map(secret => ({ id: secret.id, name: secret.name, mono: true, ...(secret.description ? { detail: secret.description } : {}),
        once: mine(secret)?.scope === "once", icon: <KeyRoundIcon className="jv-grant-icon" aria-hidden="true"/> }))}
      texts={{ heading: t("access.secrets"), add: t("common.add"), search: t("access.searchSecrets"), none: t("access.noSecrets"), noMatch: t("access.noMatch"), all: t("access.allSecrets"),
        nothing: <><span>{t("access.noSecretsYet")}</span><Button type="button" variant="outline" size="sm" onClick={onManageSecrets}><PlusIcon/>{t("access.newSecret")}</Button></> }}
      onGrant={async (ids, granted) => {
        const saved = new Map<string, Secret>();
        for (const id of ids) saved.set(id, await api.grantSecret(id, bot.id, granted));
        setSecrets(list => list && list.map(secret => saved.get(secret.id) ?? secret));
      }}/>
    <Grants rows grantedIds={machines.filter(machine => machine.botIds.includes(bot.id)).map(machine => machine.id)}
      items={machines.map(machine => ({ id: machine.id, name: machine.name, detail: machineAddress(machine), icon: <ServerIcon className="jv-grant-icon" aria-hidden="true"/> }))}
      texts={{ heading: t("environment.external"), add: t("common.add"), search: t("access.searchMachines"), none: t("access.noMachines"), noMatch: t("access.noMatch"), all: t("access.allMachines"),
        nothing: <><span>{t("access.noMachinesYet")}</span><Button type="button" variant="outline" size="sm" onClick={onAddMachine}><PlusIcon/>{t("machines.add")}</Button></> }}
      onGrant={async (ids, granted) => {
        // Through the Bot, so Bot info follows it home when the machine it works on is taken back.
        for (const id of ids) onSaved(await api.grantBotMachine(bot.id, id, granted));
        setMachines(list => list && list.map(machine => !ids.includes(machine.id) ? machine
          : { ...machine, botIds: granted ? [...new Set([...machine.botIds, bot.id])] : machine.botIds.filter(id => id !== bot.id) }));
      }}/>
  </section>;
}
