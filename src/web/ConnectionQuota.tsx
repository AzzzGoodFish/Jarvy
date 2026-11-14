import { Fragment, useEffect, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { api } from "./api";
import { QUOTA_PROVIDERS, type ConnectionQuota, type ModelConnection, type QuotaWindow } from "../contract/models";
import { Button } from "./components/ui/button";
import { formatDate, formatNumber, getLocale, t } from "./i18n";
import { errorText } from "./errors";
import "./styles/quota.css";

/** A connection that may have usage limits to show (A94): signed in to a subscription provider Jarvy reads them from. */
export const hasQuota = (connection: ModelConnection) => connection.authType === "oauth" && connection.configured && QUOTA_PROVIDERS.includes(connection.providerName);
/** Below this share a limit is shown as running low. */
const LOW = 0.2;

/** The limits of every connection that has them, read once the list is shown; a failed read leaves the row as it was. */
export function useQuotas(connections: ModelConnection[]): Record<string, ConnectionQuota> {
  const [quotas, setQuotas] = useState<Record<string, ConnectionQuota>>({});
  const ids = connections.filter(hasQuota).map(connection => connection.id).join(",");
  useEffect(() => {
    let alive = true;
    for (const id of ids ? ids.split(",") : []) void api.connectionQuota(id).then(quota => { if (alive) setQuotas(current => ({ ...current, [id]: quota })); }, () => {});
    return () => { alive = false; };
  }, [ids]);
  return quotas;
}

/** The row's few words: the main windows, or for pools the two lowest; undefined when there is nothing to say. */
export function QuotaSummary({ quota }: { quota?: ConnectionQuota }) {
  if (!quota || quota.state !== "ok" || !quota.windows.length) return null;
  const plain = quota.windows.filter(window => !window.name);
  const shown = plain.length ? plain.slice(0, 2) : [...quota.windows].sort((a, b) => a.remaining - b.remaining).slice(0, 2);
  return <>{shown.map(window => <Fragment key={windowKey(window)}>{" · "}<span className="jv-quota-brief" data-low={window.remaining < LOW || undefined}>
    {window.kind === "credits" && window.amount ? t("quota.creditsLeft", { amount: amount(window.amount.left, window.amount.unit) }) : t("quota.summary", { label: spaced(label(window)), percent: percent(window.remaining) })}
  </span></Fragment>)}</>;
}
/** In Chinese a Latin name keeps a space before the words after it: "Claude 剩 12%", "5 小时剩 82%". */
const spaced = (text: string) => getLocale() === "zh" && /[\x21-\x7e]$/.test(text) ? `${text} ` : text;

/** The connection page's usage: each limit with what is left and when it resets, and a refresh. */
export function QuotaSection({ connection }: { connection: ModelConnection }) {
  const [quota, setQuota] = useState<ConnectionQuota>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
  const id = connection.id;
  useEffect(() => {
    let alive = true;
    setQuota(undefined); setError("");
    api.connectionQuota(id).then(next => { if (alive) setQuota(next); }, reason => { if (alive) setError(errorText(reason, "common.failed")); });
    // What "3 minutes ago" and "resets in 2 hours" say moves on while the page is open.
    const timer = setInterval(() => setTick(value => value + 1), 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [id]);
  async function refresh() {
    setBusy(true); setError("");
    try { setQuota(await api.connectionQuota(id, true)); }
    catch (reason) { setError(errorText(reason, "common.failed")); }
    finally { setBusy(false); }
  }
  // A provider with nothing to report and no page of its own: the section isn't shown.
  if (quota?.state === "none" && !quota.link) return null;
  const when = quota?.checkedAt ? t(quota.source === "response" ? "quota.fromReply" : "quota.checked", { time: ago(quota.checkedAt) }) : "";
  return <section className="jv-section" aria-label={t("quota.title")}>
    <div className="jv-section-head"><h3 className="jv-section-title">{t("quota.title")}{quota?.plan && <span>{plan(quota.plan)}</span>}</h3>
      {quota && quota.state !== "none" && <div className="jv-section-actions">
        {when && <span className="jv-quota-when">{when}</span>}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCwIcon className={busy ? "animate-spin" : undefined}/>{t("quota.refresh")}</Button>
      </div>}
    </div>
    <div className="jv-panel jv-quota">
      {!quota && !error && <p role="status" className="jv-hint">{t("quota.checking")}</p>}
      {quota?.state === "none" && <div className="jv-quota-none"><p className="jv-hint">{t("quota.noReport")}</p>
        <Button asChild variant="outline" size="sm"><a href={quota.link} target="_blank" rel="noopener noreferrer">{t("quota.openPage")}<ExternalLinkIcon/></a></Button></div>}
      {quota?.state === "unchecked" && <p className="jv-hint">{t("quota.unchecked")}</p>}
      {quota?.state === "ok" && !quota.windows.length && <p className="jv-hint">{t("quota.unlimited")}</p>}
      {quota?.windows.map(window => <QuotaRow key={windowKey(window)} window={window}/>)}
      {(error || quota?.error) && <p role="alert" className="jv-quota-error">
        {error || (quota?.state === "failed" ? t("quota.failed", { error: quota.error! }) : t("quota.stale", { error: quota!.error! }))}</p>}
    </div>
  </section>;
}

function QuotaRow({ window }: { window: QuotaWindow }) {
  const low = window.remaining < LOW;
  return <div className="jv-quota-row" data-low={low || undefined}>
    <div className="jv-quota-line"><strong>{label(window)}</strong>
      <span>{window.kind === "credits" && window.amount ? t("quota.creditsLeft", { amount: amount(window.amount.left, window.amount.unit) }) : t("quota.left", { percent: percent(window.remaining) })}</span></div>
    <div className="jv-quota-bar" role="meter" aria-label={label(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.remaining * 100)}>
      <span style={{ width: `${Math.max(window.remaining > 0 ? 2 : 0, window.remaining * 100)}%` }}/></div>
    {(window.resetsAt || window.amount) && <div className="jv-quota-meta">
      <span>{window.resetsAt ? resets(window.resetsAt) : ""}</span>
      {window.amount && <span>{t("quota.amountLeft", { left: amount(window.amount.left, window.amount.unit), total: amount(window.amount.total, window.amount.unit) })}</span>}
    </div>}
  </div>;
}

const windowKey = (window: QuotaWindow) => `${window.kind}-${window.hours ?? ""}-${window.name ?? ""}`;
/** A window's name: its span, the provider's name for it, or both. */
function label(window: QuotaWindow): string {
  const span = window.kind === "hours" ? t("quota.hours", { count: window.hours ?? 0 }) : window.kind === "pool" ? "" : t(`quota.${window.kind}`);
  const name = window.name === "premium" || window.name === "chat" || window.name === "completions" ? t(`quota.${window.name}`) : window.name;
  if (!name) return span;
  // Copilot's limits are all monthly: the name says enough.
  return span && window.kind !== "month" ? t("quota.named", { name, window: span }) : name;
}
const percent = (share: number) => formatNumber(share, { style: "percent", maximumFractionDigits: 0 });
const amount = (value: number, unit: "requests" | "usd") => unit === "usd" ? formatNumber(value, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }) : formatNumber(value, { maximumFractionDigits: 0 });
/** A plan as the provider names it, capitalized: `pro` is Pro. */
const plan = (name: string) => name.replace(/[_-]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
function ago(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return t("quota.justNow");
  return minutes < 60 ? t("quota.minutesAgo", { count: minutes }) : t("quota.hoursAgo", { count: Math.floor(minutes / 60) });
}
function resets(time: number): string {
  const minutes = Math.ceil((time - Date.now()) / 60_000);
  if (minutes <= 0) return t("quota.resetsSoon");
  if (minutes < 60) return t("quota.resetsInMinutes", { count: minutes });
  if (minutes < 24 * 60) return t("quota.resetsInHours", { count: Math.round(minutes / 60) });
  const zh = getLocale() === "zh";
  return t("quota.resetsOn", { date: formatDate(time, { month: zh ? "long" : "short", day: "numeric", hour: zh ? "2-digit" : "numeric", minute: "2-digit" }) });
}
