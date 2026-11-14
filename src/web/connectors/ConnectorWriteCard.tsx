import { useState, type FormEvent } from "react";
import { ChevronsUpDownIcon, MailIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorWriteAsk, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

const ACTION_KEYS: Record<string, Parameters<typeof t>[0]> = {
  create_issue: "connectorAction.create_issue",
  update_issue: "connectorAction.update_issue",
  create_comment: "connectorAction.create_comment",
  create_page: "connectorAction.create_page",
  update_page: "connectorAction.update_page",
  append_block_children: "connectorAction.append_block_children",
  send_message: "connectorAction.send_message",
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
  channel: "connectorField.channel",
  priority: "connectorField.priority",
  status: "connectorField.status",
  assignee: "connectorField.assignee",
  labels: "connectorField.labels",
  parent: "connectorField.parent",
  url: "connectorField.url",
  owner: "connectorField.owner",
  repo: "connectorField.repo",
  number: "connectorField.number",
  thread_ts: "connectorField.thread_ts",
};

const HEADING_KEYS = new Set(["subject", "title", "name"]);

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
    value: overrides[field.key] ?? field.value,
  }));
  if (overrides.cc?.trim() && !fields.some(f => f.key === "cc")) {
    fields.push({ key: "cc", label: "Cc", value: overrides.cc.trim() });
  }
  return fields;
}

/** Interactive draft & confirmation card for write tools on confirm_writes connectors (A95). */
export function ConnectorWriteCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorWrite: ConnectorWriteAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorWrite;
  const toolLower = ask.toolName.toLowerCase();
  const isMail = toolLower === "send_email" || toolLower === "create_draft" || ask.provider === "gmail";
  const isSendLike = isMail || toolLower === "send_message";
  const actionKey = ACTION_KEYS[toolLower];
  const actionTitle = actionKey ? t(actionKey) : ask.actionLabel;
  const kindTitle = isMail ? t("connectorCard.emailKind") : ask.name;

  const [draftValues, setDraftValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(ask.fields.map(field => [field.key, field.value])),
  );
  const [expandedBody, setExpandedBody] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const { busy, error, run } = useAction();

  if (question.state !== "pending") {
    const finalFields = resolvedFields(ask, question.answer?.custom);
    const targetField = finalFields.find(f => ["to", "channel", "repo", "team"].includes(f.key));
    const subjectField = finalFields.find(f => HEADING_KEYS.has(f.key)) ?? finalFields[0];
    const targetText = targetField?.value.split("\n")[0]?.slice(0, 60) ?? "";
    const subjectText = subjectField && subjectField !== targetField ? subjectField.value.split("\n")[0]?.slice(0, 60) : "";
    const summaryLine = targetText && subjectText && question.state === "answered"
      ? `${targetText} — “${subjectText}”`
      : targetText || subjectText || actionTitle;
    const statusWord = question.state === "answered"
      ? t(isSendLike ? "connectorCard.sentStatus" : "connectorCard.confirmedStatus")
      : question.state === "dismissed" ? t("connectorCard.discardedStatus") : t("connectorCard.ignoredStatus");

    return <div className="jv-connector-settled" data-state={question.state} data-open={settledOpen || undefined}>
      <button type="button" className="jv-connector-settled-bar" aria-expanded={settledOpen} onClick={() => setSettledOpen(v => !v)}>
        <span className="jv-question-icon jv-connector-settled-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
        <strong className="jv-connector-settled-title">{kindTitle}</strong>
        <span className="jv-connector-settled-meta">{statusWord} · {summaryLine}</span>
        <ChevronsUpDownIcon className="jv-connector-settled-chevron" aria-hidden="true"/>
      </button>
      {settledOpen && finalFields.length > 0 && <dl className="jv-connector-settled-body">
        {finalFields.map((field, index) => {
          const labelKey = FIELD_KEYS[field.key];
          return <div key={`${field.key}-${index}`} className="jv-connector-field" data-multiline={field.multiline || undefined}>
            <dt>{labelKey ? t(labelKey) : field.label}</dt>
            <dd>{field.value}</dd>
          </div>;
        })}
      </dl>}
    </div>;
  }

  const headingField = ask.fields.find(f => HEADING_KEYS.has(f.key) && !f.multiline);
  const singleFields = ask.fields.filter(f => !f.multiline && f !== headingField);
  const multiFields = ask.fields.filter(f => f.multiline);
  const hasCcField = singleFields.some(f => f.key === "cc");
  const canSubmit = ask.fields.every(field => (draftValues[field.key] ?? field.value).trim().length > 0);

  const settle = (action: "answer" | "dismiss") => void run("write", async () => {
    const edited = Object.keys(draftValues).some(k => draftValues[k] !== (ask.fields.find(f => f.key === k)?.value ?? ""));
    const body = action === "answer"
      ? { action: "answer" as const, selected: [0], ...(edited ? { custom: JSON.stringify(draftValues) } : {}) }
      : { action: "dismiss" as const };
    onSettled(await api.answerQuestion(message.chatId, message.id, body));
  }, "question.failed");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && canSubmit) settle("answer");
  };

  return <form className="jv-question jv-secret-request jv-connector-composer" autoComplete="off" aria-label={`${kindTitle} · ${actionTitle}`} aria-busy={busy || undefined} onSubmit={onSubmit}>
    <div className="jv-question-head jv-connector-composer-head">
      <span className="jv-question-icon">{isMail ? <MailIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{kindTitle}</p>
        {!isMail && <p className="jv-question-detail">{actionTitle}</p>}
      </div>
    </div>

    <div className="jv-question-body jv-connector-composer-body">
      {headingField && <input
        type="text"
        aria-label={FIELD_KEYS[headingField.key] ? t(FIELD_KEYS[headingField.key]!) : headingField.label}
        className="jv-connector-composer-subject"
        value={draftValues[headingField.key] ?? headingField.value}
        disabled={busy}
        onChange={event => setDraftValues(prev => ({ ...prev, [headingField.key]: event.target.value }))}
      />}

      <div className="jv-connector-composer-meta">
        {isMail && ask.account && <div className="jv-connector-composer-row">
          <span>{t("connectorField.from")}</span>
          <span className="jv-connector-composer-static">{ask.account}</span>
        </div>}
        {singleFields.map((field, index) => {
          const labelKey = FIELD_KEYS[field.key];
          const label = labelKey ? t(labelKey) : field.label;
          const val = draftValues[field.key] ?? field.value;
          return <label key={`${field.key}-${index}`} className="jv-connector-composer-row">
            <span>{label}</span>
            <input
              type="text"
              className="jv-connector-composer-input"
              value={val}
              disabled={busy}
              onChange={event => setDraftValues(prev => ({ ...prev, [field.key]: event.target.value }))}
            />
          </label>;
        })}
        {isMail && !hasCcField && <label className="jv-connector-composer-row">
          <span>{t("connectorField.cc")}</span>
          <input
            type="text"
            className="jv-connector-composer-input"
            placeholder="name@example.com"
            value={draftValues.cc ?? ""}
            disabled={busy}
            onChange={event => setDraftValues(prev => ({ ...prev, cc: event.target.value }))}
          />
        </label>}
      </div>

      {multiFields.map((field, index) => {
        const labelKey = FIELD_KEYS[field.key];
        const label = labelKey ? t(labelKey) : field.label;
        const val = draftValues[field.key] ?? field.value;
        const lineCount = val.split("\n").reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / 32)), 0);
        const isLong = lineCount > 10;
        return <div key={`${field.key}-${index}`} className="jv-connector-composer-text">
          <textarea
            aria-label={label}
            className="jv-connector-composer-textarea"
            rows={isLong && !expandedBody ? 6 : Math.min(14, Math.max(4, lineCount))}
            value={val}
            disabled={busy}
            onChange={event => setDraftValues(prev => ({ ...prev, [field.key]: event.target.value }))}
          />
          {isLong && <button type="button" className="jv-connector-composer-more" onClick={() => setExpandedBody(v => !v)}>
            {t(expandedBody ? "connectorCard.showLess" : "connectorCard.showMore")}
          </button>}
        </div>;
      })}

      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={() => settle("dismiss")}>{t("connectorCard.writeDiscard")}</button>
      <button type="submit" className="ui-button ui-primary" disabled={busy || !canSubmit}>
        {isSendLike ? t("connectorCard.send") : actionKey ? actionTitle : t("connectorCard.writeConfirm")}
      </button>
    </div>
  </form>;
}
