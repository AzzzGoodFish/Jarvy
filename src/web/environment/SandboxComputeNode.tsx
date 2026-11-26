import { useEffect, useState } from "react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Device } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { useAction } from "../action";

/** Preferred compute node selector and slot reclamation for a container sandbox (A108, A109).
 * Allows steering a Bot's remote sandbox to a specific `--sandbox` compute node with automatic failover. */
export function SandboxComputeNode({
  bot, devices: providedDevices, disabled, onSaved,
}: {
  bot: Bot;
  devices?: Device[];
  disabled: boolean;
  onSaved: (bot: Bot) => void;
}) {
  const computer = bot.environment.computer!;
  const [fetched, setFetched] = useState<Device[] | null>(null);
  const { doing, error, run } = useAction<"select" | "reclaim">();

  useEffect(() => {
    if (providedDevices !== undefined) return;
    let alive = true;
    void api.devices().then(view => { if (alive) setFetched(view.devices); }).catch(() => {});
    return () => { alive = false; };
  }, [providedDevices]);

  if (computer.type !== "container") return null;
  const allDevices = providedDevices ?? fetched ?? [];
  const poolNodes = allDevices.filter(d => d.capabilities.includes("sandbox") || Boolean(d.sandbox) || d.id === computer.preferredComputeNode);

  // Hide completely on classic single-machine Docker setups with no compute nodes configured.
  if (computer.localDocker && !computer.computeNode && !computer.preferredComputeNode && poolNodes.length === 0) return null;

  const preferred = computer.preferredComputeNode ?? "";
  const hostLabel = computer.computeNode
    ? computer.computeNode.name
    : computer.localDocker
      ? t("environment.computeLocal")
      : t("environment.computeWorkspaceOnly");

  return <>
    <div className="jv-list-row jv-static-row jv-env-fact">
      <span>{t("environment.computeHost")}</span>
      <span className="jv-env-value">{hostLabel}</span>
    </div>
    {poolNodes.length > 0 && <div className="jv-list-row jv-static-row jv-env-fact jv-env-type">
      <span>{t("environment.computePreferred")}</span>
      <select
        className="jv-env-select"
        aria-label={t("environment.computePreferred")}
        disabled={disabled || !!doing}
        value={preferred}
        onChange={event => {
          const next = event.target.value || null;
          void run("select", async () => onSaved(await api.setComputerNode(bot.id, next)), "common.failed");
        }}>
        <option value="">{t("environment.computeAuto")}</option>
        {poolNodes.map(node => {
          const online = node.online && !node.paused && Boolean(node.sandbox?.docker);
          const load = online && node.sandbox ? ` (${node.sandbox.activeContainers}/${node.sandbox.maxContainers})` : "";
          const stateText = online ? `${t("devices.online")}${load}` : t("devices.offline");
          return <option key={node.id} value={node.id}>{`${node.name} · ${stateText}`}</option>;
        })}
      </select>
    </div>}
    {(poolNodes.length > 0 || computer.computeNode || error) && <div className="jv-list-row jv-static-row jv-env-details">
      {poolNodes.length > 0 && <p>{t("environment.computeFailoverHint")}</p>}
      {computer.computeNode && <div className="jv-env-actions">
        <Button
          type="button" variant="outline" size="sm" disabled={disabled || !!doing}
          onClick={() => void run("reclaim", async () => onSaved(await api.reclaimComputer(bot.id)), "common.failed")}>
          {t(doing === "reclaim" ? "environment.reclaiming" : "environment.reclaim")}
        </Button>
      </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}
  </>;
}
