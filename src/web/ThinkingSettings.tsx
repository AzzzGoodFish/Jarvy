import type { ConfiguredModel } from "./api";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { t } from "./i18n";

// Mirrors Pi 1.2.0 OpenAICompletionsCompat.thinkingFormat. Kept in the web bundle instead of an
// API call because it only feeds a menu; the server's installModel still rejects unknown values.
const FORMATS = ["openai", "openrouter", "deepseek", "zai", "qwen", "together", "baseten", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"];
const LEVELS = [["off", "thinking.level.off"], ["minimal", "thinking.level.minimal"], ["low", "thinking.level.low"], ["medium", "thinking.level.medium"], ["high", "thinking.level.high"], ["xhigh", "thinking.level.xhigh"], ["max", "thinking.level.max"]] as const;
type Level = typeof LEVELS[number][0];
type Mode = "default" | "unsupported" | "custom";
// Pi getSupportedThinkingLevels: null = unsupported; off…high default to supported, while
// xhigh/max need an explicit value. Duplicated (8 lines) to avoid bundling pi-ai into the web app.
const explicitOnly = (level: Level) => level === "xhigh" || level === "max";
function modeOf(map: ConfiguredModel["thinkingLevelMap"], level: Level): Mode {
  const value = map[level];
  if (value === null || (value === undefined && explicitOnly(level))) return "unsupported";
  return value === undefined ? "default" : "custom";
}
export function supportedLevels(model: Pick<ConfiguredModel, "reasoning" | "thinkingLevelMap">): string[] {
  if (!model.reasoning) return [t("thinking.level.off")];
  return LEVELS.filter(([level]) => modeOf(model.thinkingLevelMap, level) !== "unsupported").map(([, label]) => t(label));
}

export function ThinkingSettings({ model, api, onChange }: { model: ConfiguredModel; api: string; onChange: (patch: Partial<ConfiguredModel>) => void }) {
  const map = model.thinkingLevelMap;
  const setLevel = (level: Level, mode: Mode, value?: string) => {
    const next = { ...map };
    if (mode === "default") delete next[level];
    else if (mode === "unsupported") next[level] = null;
    else next[level] = value ?? (typeof map[level] === "string" ? map[level] : level);
    onChange({ thinkingLevelMap: next });
  };
  const completions = api === "openai-completions";
  const formats = model.thinkingFormat && !FORMATS.includes(model.thinkingFormat) ? [...FORMATS, model.thinkingFormat] : FORMATS;
  return <section className="jv-thinking"><h4>{t("thinking.title")}</h4>
    <div className="jv-field"><span>{t("thinking.format")}</span>
      <Select value={model.thinkingFormat || "default"} disabled={!completions && !model.thinkingFormat} onValueChange={value => onChange({ thinkingFormat: value === "default" ? "" : value })}>
        <SelectTrigger aria-label={t("thinking.format")}><SelectValue/></SelectTrigger>
        <SelectContent className="jv-select-menu"><SelectItem value="default">{t("thinking.protocolDefault")}</SelectItem>{formats.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
      </Select>
      {!completions && <small className="jv-field-hint">{t("thinking.onlyCompletions")}</small>}
    </div>
    <div className="jv-thinking-levels" role="group" aria-label={t("thinking.levels")}>
      {LEVELS.map(([level, label]) => {
        const mode = modeOf(map, level);
        return <div className="jv-thinking-level" key={level}>
          <span>{t(label)}<code>{level}</code></span>
          <Select value={mode} onValueChange={value => setLevel(level, value as Mode)}>
            <SelectTrigger aria-label={t("thinking.levelName", { level: t(label) })}><SelectValue/></SelectTrigger>
            <SelectContent className="jv-select-menu">
              {!explicitOnly(level) && <SelectItem value="default">{t("thinking.supportedDefault")}</SelectItem>}
              <SelectItem value="unsupported">{t("thinking.unsupported")}</SelectItem>
              <SelectItem value="custom">{t("thinking.supportedCustom")}</SelectItem>
            </SelectContent>
          </Select>
          {mode === "custom" ? <Input className="jv-mono" required aria-label={t("thinking.levelValue", { level: t(label) })} maxLength={80} value={map[level] ?? ""} onChange={event => setLevel(level, "custom", event.target.value)}/> : <span/>}
        </div>;
      })}
    </div>
    <p className="jv-field-hint">{t("thinking.supported", { levels: supportedLevels(model).join(" · ") })}</p>
  </section>;
}
