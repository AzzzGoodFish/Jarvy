import { useState, type ReactNode } from "react";
import { CheckIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { useAction } from "../action";

/** One thing a grant list holds: a Bot, a secret, a machine. `detail` goes under the name in a list of rows; `once`: only
 * for the run under way. */
export interface GrantItem { id: string; name: string; detail?: string; once?: boolean; mono?: boolean; icon?: ReactNode }
/** The words of one list. `nothing`: what the picker says when there is nothing to pick at all, with a way to make one. */
export interface GrantTexts { heading: string; add: string; search: string; none: string; nothing: ReactNode; noMatch: string; all: string }

/** What has access, kept like a channel's members: the granted ones with remove, and Add opening a search to pick one
 * or more of the rest. The picker opens in place, since Settings and Bot info are dialogs. Removing takes effect at
 * once; it can be added back. `rows`: one per line with its detail (secrets, machines) rather than chips (Bots). */
export function Grants({ items, grantedIds, texts, rows, onGrant }: {
  items: GrantItem[]; grantedIds: string[]; texts: GrantTexts; rows?: boolean; onGrant: (ids: string[], granted: boolean) => Promise<void>;
}) {
  const [picking, setPicking] = useState(false), [query, setQuery] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run: perform } = useAction();
  const granted = grantedIds.map(id => items.find(item => item.id === id)).filter((item): item is GrantItem => !!item);
  const candidates = items.filter(item => !grantedIds.includes(item.id));
  const needle = query.trim().toLowerCase();
  const shown = candidates.filter(item => item.name.toLowerCase().includes(needle) || !!item.detail?.toLowerCase().includes(needle));
  const close = () => { setPicking(false); setQuery(""); setPicked([]); };
  const toggle = (id: string) => setPicked(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
  const run = (action: () => Promise<void>) => perform("grant", action);
  const add = () => run(async () => { await onGrant(picked, true); close(); });
  const label = (item: GrantItem) => rows
    ? <span className="jv-grant-text"><strong className={item.mono ? "jv-mono" : undefined}>{item.name}</strong>{item.detail && <span>{item.detail}</span>}</span>
    : <span className="jv-secret-bot-name">{item.name}</span>;
  return <section className="jv-secret-grants" aria-label={texts.heading}>
    <div className="jv-secret-grants-head"><h4 className="jv-secret-heading">{texts.heading}{granted.length > 0 && <span> · {granted.length}</span>}</h4>
      {!picking && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}><PlusIcon/>{texts.add}</Button>}</div>
    {granted.length > 0 ? <ul className="jv-secret-granted" data-rows={rows || undefined}>{granted.map(item => <li key={item.id}>
      {item.icon}{label(item)}
      {item.once && <span className="jv-secret-once">{t("secrets.onceTag")}</span>}
      <Button type="button" variant="ghost" size="icon-sm" className="jv-secret-revoke" disabled={busy} aria-label={t("secrets.revoke", { name: item.name })}
        onClick={() => void run(() => onGrant([item.id], false))}><XIcon/></Button>
    </li>)}</ul> : !picking && <p className="jv-hint">{texts.none}</p>}
    {picking && <div className="jv-secret-picker">
      {items.length > 0 && <label className="jv-search"><SearchIcon aria-hidden="true"/><input type="search" autoFocus value={query} placeholder={texts.search} aria-label={texts.search}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); if (shown.length === 1) toggle(shown[0]!.id); } }}/></label>}
      <div className="jv-secret-options" role="listbox" aria-multiselectable="true" aria-label={texts.add} data-rows={rows || undefined}>
        {shown.map(item => <button key={item.id} type="button" role="option" aria-selected={picked.includes(item.id)} className="jv-secret-option" onClick={() => toggle(item.id)}>
          {item.icon}{label(item)}{picked.includes(item.id) && <CheckIcon aria-hidden="true"/>}
        </button>)}
        {shown.length === 0 && (items.length ? <p className="jv-hint">{candidates.length ? texts.noMatch : texts.all}</p> : <div className="jv-hint jv-grant-nothing">{texts.nothing}</div>)}
      </div>
      <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={close}>{t("common.cancel")}</Button>
        <Button type="button" className="jv-primary" size="sm" disabled={busy || !picked.length} onClick={() => void add()}>{picked.length ? t("dialogs.addCount", { count: picked.length }) : t("common.add")}</Button></div>
    </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
