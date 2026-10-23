import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { api, type Bot, type BotModelGroup, type ModelConnection } from "./api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { getLocale, t, type Key } from "./i18n";
import "./styles/model-workbench.css";
import "./styles/bot-model.css";
import { errorText } from "./errors";

const DESCRIPTIONS: Record<string, Key> = { auto: "botModel.auto", off: "botModel.off", minimal: "botModel.minimal", low: "botModel.low", medium: "botModel.medium", high: "botModel.high", xhigh: "botModel.xhigh", max: "botModel.max" };
const keyOf = (connectionId: string, modelId: string) => JSON.stringify([connectionId, modelId]);
export function BotModelControls({ bot, connections, onSaved, onManage }: {
  bot: Bot; connections: ModelConnection[]; onSaved: (bot: Bot) => void; onManage: () => void;
}) {
  const [groups, setGroups] = useState<BotModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Bot info is a modal dialog that locks scrolling (wheel and touch) everywhere outside itself, so the model menu — a
  // non-modal popover, without a lock of its own like Select has — opens inside the dialog that holds it (none: <body>,
  // as on the onboarding card in a DM), and stays within it, since the dialog clips what sticks out.
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const listId = useId();
  useEffect(() => {
    let live = true;
    setLoading(true); setLoadError("");
    api.modelOptions().then(result => { if (live) setGroups(result.connections); })
      .catch(reason => { if (live) setLoadError(errorText(reason, "botModel.loadFailed")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [connections, attempt]);
  const all = groups.flatMap(group => group.models.map(model => ({ ...model, connectionId: group.id, connectionName: group.name, key: keyOf(group.id, model.id) })))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const current = all.find(model => model.connectionId === bot.connectionId && model.id === bot.modelId);
  const currentConnection = connections.find(connection => connection.id === bot.connectionId);
  const currentModel = currentConnection?.models.find(model => model.id === bot.modelId);
  const filtered = all.filter(model => `${model.name} ${model.id} ${model.connectionName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visible = groups.map(group => ({ ...group, models: filtered.filter(model => model.connectionId === group.id) })).filter(group => group.models.length);
  const ordered = visible.flatMap(group => group.models);
  const showSearch = all.length > 8;
  const thinkingLabel = bot.thinkingLevel === "auto" ? `auto${bot.effectiveThinkingLevel ? ` · ${bot.effectiveThinkingLevel}` : ""}` : bot.effectiveThinkingLevel ?? bot.thinkingLevel;
  function openMenu(value: boolean) { setOpen(value); setQuery(""); setActive(-1); }
  async function choose(connectionId: string, modelId: string, thinkingLevel: string) {
    openMenu(false);
    setBusy(true); setError("");
    try { onSaved(await api.selectBotModel(bot.id, connectionId, modelId, thinkingLevel, getLocale())); }
    catch (reason) { setError(errorText(reason, "botModel.switchFailed")); }
    finally { setBusy(false); }
  }
  function navigate(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = event.key === "ArrowDown" ? Math.min(active + 1, ordered.length - 1) : Math.max(active - 1, 0);
      setActive(index); document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && ordered[active]) {
      event.preventDefault(); const model = ordered[active]!; void choose(model.connectionId, model.id, bot.thinkingLevel);
    }
  }
  return <div className="jv-bot-model jv-ui" aria-busy={busy || loading} ref={element => setDialog(element?.closest<HTMLElement>("[data-slot=dialog-content]") ?? null)}>
    <div className="jv-bot-model-fields">
      <div className="jv-bot-model-field"><span className="jv-field-label">{t("usage.model")}</span>
        <Popover.Root open={open} onOpenChange={openMenu}>
          <Popover.Trigger className="jv-model-trigger" aria-label={t("botModel.pick")} aria-haspopup="listbox" disabled={busy || loading || !!loadError}>
            <span>{current?.name ?? currentModel?.name ?? t(bot.connectionId ? "botModel.broken" : "botModel.choose")}</span>{busy ? <LoaderCircleIcon className="animate-spin"/> : <ChevronDownIcon/>}
          </Popover.Trigger>
          <Popover.Portal container={dialog}><Popover.Content className="jv-model-menu jv-ui" align="start" sideOffset={6} collisionPadding={12} collisionBoundary={dialog}
            onOpenAutoFocus={event => { event.preventDefault(); (showSearch ? search.current : list.current)?.focus(); }} onKeyDown={navigate}>
            {showSearch && <div className="jv-model-search"><SearchIcon/><input ref={search} role="combobox" aria-label={t("botModel.filter")} aria-expanded="true" aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              placeholder={t("botModel.filterPlaceholder")} value={query} onChange={event => { setQuery(event.target.value); setActive(-1); }} autoComplete="off" spellCheck={false}/></div>}
            <div ref={list} id={listId} role="listbox" aria-label={t("botModel.list")} tabIndex={-1} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} className="jv-model-options">
              {visible.map(group => <div role="group" aria-label={group.name} key={group.id}>
                <div className="jv-model-group-label">{group.name}</div>
                {group.models.map(model => {
                  const index = ordered.indexOf(model), selected = model.connectionId === bot.connectionId && model.id === bot.modelId;
                  return <button type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} key={model.key} aria-selected={selected} data-active={index === active || undefined}
                    title={model.id} onClick={() => void choose(model.connectionId, model.id, bot.thinkingLevel)}>
                    <span className="jv-option-check">{selected && <CheckIcon/>}</span><span>{model.name}</span>
                  </button>;
                })}
              </div>)}
              {!ordered.length && <p className="jv-menu-empty">{t(all.length ? "botModel.noMatch" : "botModel.none")}</p>}
            </div>
            <button type="button" className="jv-menu-manage" onClick={() => { openMenu(false); onManage(); }}>{t("botModel.manage")}</button>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        {(current || currentConnection) && <span className="jv-field-note">{current?.connectionName ?? currentConnection?.displayName}</span>}
      </div>
      <div className="jv-bot-model-field"><span className="jv-field-label">{t("botModel.thinking")}</span>
        <Select value={bot.thinkingLevel === "auto" ? "auto" : bot.effectiveThinkingLevel ?? bot.thinkingLevel} disabled={busy || loading || !current || !!loadError} onValueChange={level => { if (bot.connectionId) void choose(bot.connectionId, bot.modelId, level); }}>
          <SelectTrigger className="jv-thinking-trigger" aria-label={t("botModel.pickThinking")}><SelectValue>{thinkingLabel}</SelectValue></SelectTrigger>
          <SelectContent className="jv-select-menu jv-thinking-menu" align="end">
            {["auto", ...(current?.thinking.levels ?? [])].map(level => {
              const mapped = current?.thinkingLevelMap[level], label = mapped && mapped !== level ? mapped : level;
              return <SelectItem key={level} value={level}><span className="jv-thinking-option"><span>{label}{mapped && mapped !== level && <small> ({level})</small>}</span><small>{DESCRIPTIONS[level] && t(DESCRIPTIONS[level])}</small></span></SelectItem>;
            })}
          </SelectContent>
        </Select>
      </div>
    </div>
    {loading && <p className="jv-field-note" role="status">{t("botModel.loading")}</p>}
    {busy && <p className="jv-field-note" role="status">{t("botModel.switching")}</p>}
    {loadError && <p className="jv-model-error" role="alert">{loadError} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button></p>}
    {error && <p className="jv-model-error" role="alert">{error}</p>}
  </div>;
}
