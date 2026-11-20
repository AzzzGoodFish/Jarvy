import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronsUpDownIcon, MailIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorWriteAsk, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { Markdown } from "../ui";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

const ACTION_KEYS: Record<string, Parameters<typeof t>[0]> = {
  create_issue: "connectorAction.create_issue",
  update_issue: "connectorAction.update_issue",
  create_comment: "connectorAction.create_comment",
  send_email: "connectorAction.send_email",
  create_draft: "connectorAction.create_draft",
};

const FIELD_KEYS: Record<string, Parameters<typeof t>[0]> = {
  title: "connectorField.title",
  name: "connectorField.name",
  subject: "connectorField.subject",
  team: "connectorField.team",
  project: "connectorField.project",
  description: "connectorField.description",
  body: "connectorField.body",
  content: "connectorField.content",
  message: "connectorField.message",
  text: "connectorField.text",
  comment: "connectorField.comment",
  from: "connectorField.from",
  to: "connectorField.to",
  cc: "connectorField.cc",
  bcc: "connectorField.bcc",
  priority: "connectorField.priority",
  status: "connectorField.status",
  state: "connectorField.status",
  assignee: "connectorField.assignee",
  labels: "connectorField.labels",
  parent: "connectorField.parent",
  url: "connectorField.url",
  owner: "connectorField.owner",
  repo: "connectorField.repo",
  repository: "connectorField.repo",
  number: "connectorField.number",
  issue_number: "connectorField.number",
};

const HEADING_KEYS = new Set(["subject", "title", "name"]);
const BODY_KEYS = new Set(["body", "description", "content", "message", "text", "comment"]);
const BODY_MIN_PX = 92;
const BODY_COLLAPSED_MAX_PX = 200;
const BODY_EXPANDED_MAX_PX = 560;

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  let cur = node?.parentElement ?? null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function resolvedFields(ask: ConnectorWriteAsk, customJson: string | null | undefined) {
  const overrides: Record<string, string> = {};
  if (customJson) {
    try {
      const parsed = JSON.parse(customJson) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") overrides[k] = v;
      }
    } catch { /* ignore */ }
  }
  const fields = ask.fields.map(field => ({ ...field, value: overrides[field.key] ?? field.value }));
  if (overrides.cc?.trim() && !fields.some(f => f.key === "cc")) {
    fields.push({ key: "cc", label: "Cc", value: overrides.cc.trim() });
  }
  return fields;
}

/** Interactive draft & confirmation card for connector write tools (A99):
 * Gmail uses an email-draft layout (From/To/Cc + editable subject & body); other write tools show editable fields;
 * the primary button carries a menu entry to confirm and stop asking for that tool. */
export function ConnectorWriteCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorWrite: ConnectorWriteAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorWrite;
  const toolLower = ask.toolName.toLowerCase();
  const isMail = toolLower === "send_email" || toolLower === "create_draft" || ask.provider === "gmail";
  const actionKey = ACTION_KEYS[toolLower];
  const actionTitle = actionKey ? t(actionKey) : ask.actionLabel;
  const kindTitle = isMail ? t("connectorCard.emailKind") : ask.name;

  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(ask.fields.map(field => [field.key, field.value])),
  );
  const [expandedBody, setExpandedBody] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();

  const headingField = ask.fields.find(f => HEADING_KEYS.has(f.key));
  const bodyField = ask.fields.find(f => BODY_KEYS.has(f.key));
  const metaFields = ask.fields.filter(f => f !== headingField && f !== bodyField);
  const bodyValue = bodyField ? (draft[bodyField.key] ?? "") : "";

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || question.state !== "pending") return;
    // Measuring via height=0 temporarily shrinks the scroll container and causes the browser to clamp scrollTop
    // upward; capture and restore the scroll position synchronously in the same layout pass.
    const scroller = scrollParent(el);
    const prevTop = scroller?.scrollTop ?? 0;
    const wasAtBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48 : false;
    el.style.height = "0px";
    const needed = el.scrollHeight;
    setBodyOverflows(needed > BODY_COLLAPSED_MAX_PX + 8);
    const limit = expandedBody ? BODY_EXPANDED_MAX_PX : BODY_COLLAPSED_MAX_PX;
    el.style.height = `${Math.max(BODY_MIN_PX, Math.min(needed, limit))}px`;
    if (scroller) {
      scroller.scrollTop = wasAtBottom ? scroller.scrollHeight - scroller.clientHeight : prevTop;
    }
  }, [bodyValue, expandedBody, question.state]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: Event) => { if (!splitRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  const fieldLabel = (key: string, fallback: string) => {
    const k = FIELD_KEYS[key];
    return k ? t(k) : fallback;
  };

  if (question.state !== "pending") {
    const finalFields = resolvedFields(ask, question.answer?.custom);
    const picked = question.answer?.selected[0];
    const confirmed = question.state === "answered" && (picked === 0 || picked === 2);
    const statusWord = confirmed ? t(isMail ? "connectorCard.sent" : "connectorCard.confirmed") : t("connectorCard.discarded");
    const target = finalFields.find(f => ["to", "repo", "team"].includes(f.key))?.value.split("\n")[0]?.slice(0, 60);
    const subject = (finalFields.find(f => HEADING_KEYS.has(f.key)) ?? finalFields[0])?.value.split("\n")[0]?.slice(0, 60);
    const summaryParts = [statusWord, target, subject && subject !== target ? subject : null].filter(Boolean);

    return <div className="jv-write-settled" data-state={question.state}>
      <button type="button" className="jv-write-pill" aria-expanded={settledOpen} aria-label={t("connectorCard.toggleDetails")} onClick={() => setSettledOpen(v => !v)}>
        <span className="jv-write-pill-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
        <span className="jv-write-pill-kind">{kindTitle}</span>
        <span className="jv-write-pill-summary">{summaryParts.join(" · ")}</span>
        <ChevronsUpDownIcon className="jv-write-pill-chevron" aria-hidden="true"/>
      </button>
      {settledOpen && (() => {
        const settledHeading = finalFields.find(f => HEADING_KEYS.has(f.key));
        const settledBodies = finalFields.filter(f => BODY_KEYS.has(f.key));
        const settledMeta = finalFields.filter(f => f !== settledHeading && !BODY_KEYS.has(f.key));
        const hasMeta = (isMail && Boolean(ask.account)) || settledMeta.length > 0;
        const hasContent = Boolean(settledHeading) || settledBodies.length > 0;
        return <div className="jv-write-settled-body">
          {hasMeta && <div className="jv-write-settled-meta">
            <div className="jv-write-meta">
              {isMail && ask.account && <div className="jv-write-meta-row">
                <span className="jv-write-meta-label">{t("connectorCard.from")}</span>
                <span className="jv-write-meta-static">{ask.account}</span>
              </div>}
              {settledMeta.map(field => <div key={field.key} className="jv-write-meta-row">
                <span className="jv-write-meta-label" title={fieldLabel(field.key, field.label)}>{fieldLabel(field.key, field.label)}</span>
                <span className="jv-write-meta-static">{field.value}</span>
              </div>)}
            </div>
          </div>}
          {hasContent && <div className="jv-write-settled-content">
            {settledHeading && <h4 className="jv-write-settled-title">{settledHeading.value}</h4>}
            {settledBodies.map(field => (
              <div key={field.key} className="jv-write-body-static"><Markdown text={field.value}/></div>
            ))}
          </div>}
        </div>;
      })()}
    </div>;
  }

  const editsPayload = (): string | undefined => {
    const changed: Record<string, string> = {};
    for (const field of ask.fields) {
      const next = draft[field.key];
      if (next !== undefined && next !== field.value) changed[field.key] = next;
    }
    if (isMail && draft.cc?.trim() && !ask.fields.some(f => f.key === "cc")) changed.cc = draft.cc.trim();
    return Object.keys(changed).length ? JSON.stringify(changed) : undefined;
  };

  const confirm = (always: boolean) => {
    setMenuOpen(false);
    const custom = editsPayload();
    const index = always ? 2 : 0;
    void run(always ? "confirmAlways" : "confirm", async () => {
      onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [index], ...(custom ? { custom } : {}) }));
    });
  };

  const discard = () => void run("discard", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [1] }));
  });

  const primaryLabel = isMail && toolLower === "send_email" ? t("connectorCard.send") : actionTitle;
  const alwaysLabel = isMail && toolLower === "send_email" ? t("connectorCard.sendAlways") : t("connectorCard.confirmAlways");

  return <div className="jv-question jv-write-card" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{kindTitle}</p>
        {!isMail && <p className="jv-question-detail">{actionTitle}</p>}
      </div>
    </div>

    <div className="jv-question-body">
      {headingField && (
        <input className="jv-write-subject" value={draft[headingField.key] ?? ""} placeholder={t("connectorCard.subjectPlaceholder")}
          onChange={event => setDraft(prev => ({ ...prev, [headingField.key]: event.target.value }))}/>
      )}

      {(isMail || metaFields.length > 0) && <div className="jv-write-meta">
        {isMail && ask.account && <div className="jv-write-meta-row">
          <span className="jv-write-meta-label">{t("connectorCard.from")}</span>
          <span className="jv-write-meta-static">{ask.account}</span>
        </div>}
        {metaFields.map(field => <div key={field.key} className="jv-write-meta-row">
          <span className="jv-write-meta-label" title={fieldLabel(field.key, field.label)}>{fieldLabel(field.key, field.label)}</span>
          <input className="jv-write-meta-input" value={draft[field.key] ?? ""}
            onChange={event => setDraft(prev => ({ ...prev, [field.key]: event.target.value }))}/>
        </div>)}
        {isMail && !ask.fields.some(f => f.key === "cc") && <div className="jv-write-meta-row">
          <span className="jv-write-meta-label">{t("connectorCard.cc")}</span>
          <input className="jv-write-meta-input" value={draft.cc ?? ""} placeholder={t("connectorCard.ccPlaceholder")}
            onChange={event => setDraft(prev => ({ ...prev, cc: event.target.value }))}/>
        </div>}
      </div>}

      {bodyField && <div className="jv-write-body-wrap">
        <textarea ref={bodyRef} className="jv-write-body-input"
          value={bodyValue} placeholder={t("connectorCard.bodyPlaceholder")}
          onChange={event => setDraft(prev => ({ ...prev, [bodyField.key]: event.target.value }))}/>
        {(bodyOverflows || expandedBody) && <div className="jv-write-body-toggle">
          <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedBody(v => !v)}>
            {t(expandedBody ? "connectorCard.showLess" : "connectorCard.showMore")}
          </button>
        </div>}
      </div>}

      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={discard}>{t("connectorCard.discard")}</button>
      <div className="jv-split-action" ref={splitRef}>
        <button type="button" className="ui-button ui-primary jv-split-main" disabled={busy} onClick={() => confirm(false)}>{primaryLabel}</button>
        <button type="button" className="ui-button ui-primary jv-split-caret" disabled={busy}
          aria-label={t("connectorCard.moreOptions")} aria-expanded={menuOpen} aria-haspopup="menu"
          onClick={() => setMenuOpen(v => !v)}>
          <ChevronDownIcon aria-hidden="true"/>
        </button>
        {menuOpen && <div className="jv-split-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => confirm(true)}>{alwaysLabel}</button>
        </div>}
      </div>
    </div>
  </div>;
}
