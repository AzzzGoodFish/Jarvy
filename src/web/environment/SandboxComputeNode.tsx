import { useEffect, useState } from "react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Device } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useAction } from "../action";
import { GB, short } from "./amounts";
import { isComputeNode } from "./device-roles";

const AUTO_VALUE = "__auto__";

/** Preferred compute node selector and slot reclamation for a container sandbox (A108, A109).
 * Uses Jarvy's unified Radix Select so placement matches the rest of the design system. */
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
  const poolNodes = allDevices.filter(d => isComputeNode(d) || d.id === computer.preferredComputeNode);

  // Hide completely on classic single-machine Docker setups with no compute nodes configured.
  if (computer.localDocker && !computer.computeNode && !computer.preferredComputeNode && poolNodes.length === 0) return null;

  const preferred = computer.preferredComputeNode ?? AUTO_VALUE;
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
      <Select
        value={preferred}
        disabled={disabled || !!doing}
        onValueChange={next => {
          const deviceId = next === AUTO_VALUE ? null : next;
          void run("select", async () => onSaved(await api.setComputerNode(bot.id, deviceId)), "common.failed");
        }}>
        <SelectTrigger className="jv-env-select-trigger" aria-label={t("environment.computePreferred")}>
          <SelectValue/>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_VALUE}>
            <span className="jv-env-select-item">
              <span className="jv-env-select-dot" data-state="auto" aria-hidden="true"/>
              <span>{t("environment.computeAuto")}</span>
            </span>
          </SelectItem>
          {poolNodes.map(node => {
            const online = node.online && !node.paused && Boolean(node.sandbox?.docker);
            const meta = online && node.sandbox
              ? `${node.sandbox.activeContainers}/${node.sandbox.maxContainers} · ${node.sandbox.cpus}C/${short(node.sandbox.memory / GB, 0)}G`
              : t("devices.offline");
            return <SelectItem key={node.id} value={node.id}>
              <span className="jv-env-select-item">
                <span className="jv-env-select-dot" data-state={online ? "online" : "offline"} aria-hidden="true"/>
                <span>{node.name}</span>
                <span className="jv-env-select-meta">{meta}</span>
              </span>
            </SelectItem>;
          })}
        </SelectContent>
      </Select>
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
