import { useEffect, useState } from "react";
import { BoxIcon, KeyRoundIcon, PlusIcon, ServerIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type SshMachine } from "../../contract/environment";
import { type Secret } from "../../contract/secrets";
import { type Connector } from "../../contract/connectors";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Grants } from "../secrets/Grants";
import { machineAddress } from "../environment/MachineDetail";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { safetyKey } from "../connectors/ConnectorItem";

/** Bot info's 授权 tab: the owner's secrets (A52), connectors (A94) and SSH machines (A57) this Bot may use, and for the
 * agent Bot other Bots' sandboxes (A93), each removable at once, and Add to pick more. The Bot sees all of them, granted
 * or not, and asks for the rest on a card; this is where the owner sees and changes what it has. The grants are the same
 * ones Settings shows per secret and the Environments page per machine. */
export function BotAccess({ bot, onSaved, onManageSecrets, onManageConnectors, onAddMachine }: {
  bot: Bot; onSaved: (bot: Bot) => void; onManageSecrets: () => void; onManageConnectors: () => void; onAddMachine: () => void;
}) {
  const [secrets, setSecrets] = useState<Secret[] | null>(null), [connectors, setConnectors] = useState<Connector[] | null>(null),
    [machines, setMachines] = useState<SshMachine[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.secrets(), api.connectors(), api.machines()]).then(([kept, conns, added]) => {
      if (alive) {
        setSecrets(kept.secrets.filter(secret => secret.kind === "value"));
        setConnectors(conns.connectors);
        setMachines(added.machines);
      }
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [bot.id]);
  if (failed) return <p className="jv-note-error" role="alert">{t("access.loadFailed")}</p>;
  if (!secrets || !connectors || !machines) return null;
  const mine = (secret: Secret) => secret.grants.find(grant => grant.botId === bot.id);
  const myConnector = (connector: Connector) => connector.grants.some(grant => grant.botId === bot.id);
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
    <Grants rows grantedIds={connectors.filter(myConnector).map(connector => connector.id)}
      items={connectors.map(connector => ({ id: connector.id, name: connector.name, detail: t(safetyKey(connector.safety)),
        icon: <ConnectorMark provider={connector.provider} className="jv-grant-icon"/> }))}
      texts={{ heading: t("access.connectors"), add: t("common.add"), search: t("access.searchConnectors"), none: t("access.noConnectors"), noMatch: t("access.noMatch"), all: t("access.allConnectors"),
        nothing: <><span>{t("access.noConnectorsYet")}</span><Button type="button" variant="outline" size="sm" onClick={onManageConnectors}><PlusIcon/>{t("access.newConnector")}</Button></> }}
      onGrant={async (ids, granted) => {
        const saved = new Map<string, Connector>();
        for (const id of ids) saved.set(id, await api.grantConnector(id, bot.id, granted));
        setConnectors(list => list && list.map(connector => saved.get(connector.id) ?? connector));
      }}/>
    <Grants rows grantedIds={machines.filter(machine => machine.botIds.includes(bot.id)).map(machine => machine.id)}
      items={machines.map(machine => ({ id: machine.id, name: machine.name, detail: machineAddress(machine),
        once: bot.environment.machines.find(item => item.id === machine.id)?.once === true, icon: <ServerIcon className="jv-grant-icon" aria-hidden="true"/> }))}
      texts={{ heading: t("environment.external"), add: t("common.add"), search: t("access.searchMachines"), none: t("access.noMachines"), noMatch: t("access.noMatch"), all: t("access.allMachines"),
        nothing: <><span>{t("access.noMachinesYet")}</span><Button type="button" variant="outline" size="sm" onClick={onAddMachine}><PlusIcon/>{t("machines.add")}</Button></> }}
      onGrant={async (ids, granted) => {
        // Through the Bot, so Bot info follows it home when the machine it works on is taken back.
        for (const id of ids) onSaved(await api.grantBotMachine(bot.id, id, granted));
        setMachines(list => list && list.map(machine => !ids.includes(machine.id) ? machine
          : { ...machine, botIds: granted ? [...new Set([...machine.botIds, bot.id])] : machine.botIds.filter(id => id !== bot.id) }));
      }}/>
    {bot.environment.sandboxes && <Grants rows grantedIds={bot.environment.sandboxes.filter(item => item.granted).map(item => item.id)}
      items={bot.environment.sandboxes.map(item => ({ id: item.id, name: t("access.sandboxOf", { name: item.name }), once: item.once === true, icon: <BoxIcon className="jv-grant-icon" aria-hidden="true"/> }))}
      texts={{ heading: t("access.sandboxes"), add: t("common.add"), search: t("access.searchSandboxes"), none: t("access.noSandboxes"), noMatch: t("access.noMatch"), all: t("access.allSandboxes"),
        nothing: <span>{t("access.noOtherBots")}</span> }}
      onGrant={async (ids, granted) => { for (const id of ids) onSaved(await api.grantBotSandbox(bot.id, id, granted)); }}/>}
  </section>;
}
