import { useLayoutEffect, useRef, useState } from "react";
import { ChevronsUpDownIcon, MailIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorWriteAsk, ConnectorWriteField, Question } from "../../contract/chat";
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

const isEditable = (field: ConnectorWriteField) => field.editable !== false;

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
  const fields = ask.fields.map(field => ({
    ...field,
    value: isEditable(field) && overrides[field.key] !== undefined ? overrides[field.key]! : field.value,
  }));
  if (overrides.cc?.trim() && !fields.some(f => f.key === "cc")) {
    fields.push({ key: "cc", label: "Cc", value: overrides.cc.trim(), editable: true });
  }
  return fields;
}

/** Interactive draft & confirmation card for connector write tools (A102):
 * Gmail uses an email-draft layout (From/To/Cc + editable subject & body); other write tools show editable scalar
 * fields and visibly read-only complex/masked/oversized fields. Every write action requires explicit confirmation. */
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
    Object.fromEntries(ask.fields.filter(isEditable).map(field => [field.key, field.value])),
  );
  const [expandedBody, setExpandedBody] = useState(false);
  const [expandedFields, setExpandedFields] = useState(false);
  const [expandedReadonly, setExpandedReadonly] = useState<Record<string, boolean>>({});
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();

  const headingField = ask.fields.find(f => HEADING_KEYS.has(f.key.toLowerCase()));
  const bodyField = ask.fields.find(f => BODY_KEYS.has(f.key.toLowerCase()));
  const metaFields = ask.fields.filter(f => f !== headingField && f !== bodyField);
  const bodyEditable = Boolean(bodyField && isEditable(bodyField));
  const bodyValue = bodyField ? (bodyEditable ? (draft[bodyField.key] ?? "") : bodyField.value) : "";
  const lowerCounts = new Map<string, number>();
  for (const field of ask.fields) {
    const lower = field.key.toLowerCase();
    lowerCounts.set(lower, (lowerCounts.get(lower) ?? 0) + 1);
  }

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || question.state !== "pending" || !bodyEditable) return;
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
  }, [bodyValue, bodyEditable, expandedBody, question.state]);

  const fieldLabel = (key: string, fallback: string) => {
    const lower = key.toLowerCase();
    if ((lowerCounts.get(lower) ?? 0) > 1) return fallback;
    const k = FIELD_KEYS[lower];
    return k ? t(k) : fallback;
  };

  if (question.state !== "pending") {
    const finalFields = resolvedFields(ask, question.answer?.custom);
    const picked = question.answer?.selected[0];
    const confirmed = question.state === "answered" && picked === 0;
    const statusWord = confirmed
      ? t(isMail ? "connectorCard.sent" : "connectorCard.confirmed")
      : question.state === "ignored"
        ? t(question.expiredReason === "connector_disconnected"
            ? "connectorCard.disconnected"
            : question.expiredReason === "connector_revoked"
              ? "connectorCard.revoked"
              : "connectorCard.expired")
        : t("connectorCard.discarded");
    const targetField = finalFields.find(f => ["to", "repo", "repository", "team"].includes(f.key.toLowerCase()));
    const subjectField = finalFields.find(f => HEADING_KEYS.has(f.key.toLowerCase())) ?? finalFields[0];
    const target = (targetField?.preview ?? targetField?.value)?.split("\n")[0]?.slice(0, 60);
    const subject = (subjectField?.preview ?? subjectField?.value)?.split("\n")[0]?.slice(0, 60);
    const accountSummary = !isMail && ask.account && !kindTitle.includes(ask.account) ? ask.account : null;
    const summaryParts = [statusWord, accountSummary, target, subject && subject !== target ? subject : null].filter(Boolean);

    return <div className="jv-write-settled" data-state={question.state}>
      <button type="button" className="jv-write-pill" aria-expanded={settledOpen} aria-label={t("connectorCard.toggleDetails")} onClick={() => setSettledOpen(v => !v)}>
        <span className="jv-write-pill-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
        <span className="jv-write-pill-kind">{kindTitle}</span>
        <span className="jv-write-pill-summary">{summaryParts.join(" · ")}</span>
        <ChevronsUpDownIcon className="jv-write-pill-chevron" aria-hidden="true"/>
      </button>
      {settledOpen && (() => {
        const settledHeading = finalFields.find(f => HEADING_KEYS.has(f.key.toLowerCase()));
        const settledBodies = finalFields.filter(f => BODY_KEYS.has(f.key.toLowerCase()));
        const settledMeta = finalFields.filter(f => f !== settledHeading && !BODY_KEYS.has(f.key.toLowerCase()));
        const hasMeta = Boolean(ask.account) || settledMeta.length > 0;
        const hasContent = Boolean(settledHeading) || settledBodies.length > 0;
        return <div className="jv-write-settled-body">
          {hasMeta && <div className="jv-write-settled-meta">
            <div className="jv-write-meta">
              {ask.account && <div className="jv-write-meta-row">
                <span className="jv-write-meta-label">{t(isMail ? "connectorCard.from" : "connectorCard.account")}</span>
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
      if (!isEditable(field)) continue;
      const next = draft[field.key];
      if (next !== undefined && next !== field.value) changed[field.key] = next;
    }
    if (isMail && draft.cc?.trim() && !ask.fields.some(f => f.key === "cc")) changed.cc = draft.cc.trim();
    return Object.keys(changed).length ? JSON.stringify(changed) : undefined;
  };

  const confirm = () => {
    const custom = editsPayload();
    void run("confirm", async () => {
      onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [0], ...(custom ? { custom } : {}) }));
    });
  };

  const discard = () => void run("discard", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [1] }));
  });

  const primaryLabel = isMail && toolLower === "send_email" ? t("connectorCard.send") : actionTitle;

  const pendingDetail = !isMail
    ? (ask.account && !kindTitle.includes(ask.account) ? `${actionTitle} · ${ask.account}` : actionTitle)
    : null;

  return <div className="jv-question jv-write-card" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{kindTitle}</p>
        {pendingDetail && <p className="jv-question-detail">{pendingDetail}</p>}
      </div>
    </div>

    <div className="jv-question-body">
      {headingField && (isEditable(headingField)
        ? <input className="jv-write-subject" value={draft[headingField.key] ?? ""} placeholder={t("connectorCard.subjectPlaceholder")}
            onChange={event => setDraft(prev => ({ ...prev, [headingField.key]: event.target.value }))}/>
        : <p className="jv-write-subject-static">{headingField.value}</p>
      )}

      {(isMail || metaFields.length > 0) && <>
        <div className="jv-write-meta">
          {isMail && ask.account && <div className="jv-write-meta-row">
            <span className="jv-write-meta-label">{t("connectorCard.from")}</span>
            <span className="jv-write-meta-static">{ask.account}</span>
          </div>}
          {(expandedFields ? metaFields : metaFields.slice(0, 6)).map(field => {
            const longStatic = !isEditable(field) && (field.value.length > 160 || field.value.includes("\n"));
            const openStatic = Boolean(expandedReadonly[field.key]);
            return <div key={field.key} className="jv-write-meta-row" data-multiline={longStatic || undefined}>
              <span className="jv-write-meta-label" title={fieldLabel(field.key, field.label)}>{fieldLabel(field.key, field.label)}</span>
              {isEditable(field)
                ? <input className="jv-write-meta-input" value={draft[field.key] ?? ""}
                    onChange={event => setDraft(prev => ({ ...prev, [field.key]: event.target.value }))}/>
                : longStatic
                  ? <div className="jv-write-readonly-wrap">
                      <pre className="jv-write-readonly-block" data-expanded={openStatic || undefined}>{field.value}</pre>
                      <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedReadonly(prev => ({ ...prev, [field.key]: !openStatic }))}>
                        {t(openStatic ? "connectorCard.showLess" : "connectorCard.showMore")}
                      </button>
                    </div>
                  : <span className="jv-write-meta-static" title={field.value}>{field.value}</span>}
            </div>;
          })}
          {isMail && !ask.fields.some(f => f.key === "cc") && <div className="jv-write-meta-row">
            <span className="jv-write-meta-label">{t("connectorCard.cc")}</span>
            <input className="jv-write-meta-input" value={draft.cc ?? ""} placeholder={t("connectorCard.ccPlaceholder")}
              onChange={event => setDraft(prev => ({ ...prev, cc: event.target.value }))}/>
          </div>}
        </div>
        {metaFields.length > 6 && <div className="jv-write-body-toggle">
          <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedFields(v => !v)}>
            {expandedFields ? t("connectorCard.showFewerFields") : t("connectorCard.showAllFields", { count: metaFields.length })}
          </button>
        </div>}
      </>}

      {bodyField && (bodyEditable
        ? <div className="jv-write-body-wrap">
            <textarea ref={bodyRef} className="jv-write-body-input"
              value={bodyValue} placeholder={t("connectorCard.bodyPlaceholder")}
              onChange={event => setDraft(prev => ({ ...prev, [bodyField.key]: event.target.value }))}/>
            {(bodyOverflows || expandedBody) && <div className="jv-write-body-toggle">
              <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedBody(v => !v)}>
                {t(expandedBody ? "connectorCard.showLess" : "connectorCard.showMore")}
              </button>
            </div>}
          </div>
        : <div className="jv-write-body-wrap">
            <div className="jv-write-body-static jv-write-readonly-body" data-expanded={expandedBody || undefined}><Markdown text={bodyField.value}/></div>
            {(bodyField.value.length > 360 || bodyField.value.split("\n").length > 8) && <div className="jv-write-body-toggle">
              <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedBody(v => !v)}>
                {t(expandedBody ? "connectorCard.showLess" : "connectorCard.showMore")}
              </button>
            </div>}
          </div>
      )}

      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={discard}>{t("connectorCard.discard")}</button>
      <button type="button" className="ui-button ui-primary" disabled={busy} onClick={confirm}>{primaryLabel}</button>
    </div>
  </div>;
}
