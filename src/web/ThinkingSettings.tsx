import type { ConfiguredModel } from "./api";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

// Mirrors Pi 0.99.1 OpenAICompletionsCompat.thinkingFormat. Kept in the web bundle instead of an
// API call because it only feeds a menu; the server's installModel still rejects unknown values.
const FORMATS = ["openai", "openrouter", "deepseek", "zai", "qwen", "together", "baseten", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"];
const LEVELS = [["off", "关闭"], ["minimal", "极低"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "超高"], ["max", "最高"]] as const;
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
  if (!model.reasoning) return ["关闭"];
  return LEVELS.filter(([level]) => modeOf(model.thinkingLevelMap, level) !== "unsupported").map(([, label]) => label);
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
  return <section className="jv-thinking"><h4>思考</h4>
    <div className="jv-field"><span>思考格式</span>
      <Select value={model.thinkingFormat || "default"} disabled={!completions && !model.thinkingFormat} onValueChange={value => onChange({ thinkingFormat: value === "default" ? "" : value })}>
        <SelectTrigger aria-label="思考格式"><SelectValue/></SelectTrigger>
        <SelectContent className="jv-select-menu"><SelectItem value="default">协议默认</SelectItem>{formats.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
      </Select>
      {!completions && <small className="jv-field-hint">仅 OpenAI Chat Completions 协议使用</small>}
    </div>
    <div className="jv-thinking-levels" role="group" aria-label="思考档位">
      {LEVELS.map(([level, label]) => {
        const mode = modeOf(map, level);
        return <div className="jv-thinking-level" key={level}>
          <span>{label}<code>{level}</code></span>
          <Select value={mode} onValueChange={value => setLevel(level, value as Mode)}>
            <SelectTrigger aria-label={`${label}档位`}><SelectValue/></SelectTrigger>
            <SelectContent className="jv-select-menu">
              {!explicitOnly(level) && <SelectItem value="default">支持（默认值）</SelectItem>}
              <SelectItem value="unsupported">不支持</SelectItem>
              <SelectItem value="custom">支持，发送指定值</SelectItem>
            </SelectContent>
          </Select>
          {mode === "custom" ? <Input className="jv-mono" required aria-label={`${label}档位发送值`} maxLength={80} value={map[level] ?? ""} onChange={event => setLevel(level, "custom", event.target.value)}/> : <span/>}
        </div>;
      })}
    </div>
    <p className="jv-field-hint">可选档位：{supportedLevels(model).join(" · ")}</p>
  </section>;
}
