import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorBatchWriteAsk, ConnectorBatchWriteItem, ConnectorWriteField, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { ConnectorMark } from "./ConnectorMark";
import { connectorActionLabel, connectorFieldLabel } from "./labels";
import "../styles/connectors.css";

function parseApprovedSet(ask: ConnectorBatchWriteAsk, customJson: string | null | undefined): Set<number> {
  if (!customJson) return new Set(ask.items.map(item => item.index));
  try {
    const parsed = JSON.parse(customJson) as { approved?: unknown };
    if (Array.isArray(parsed?.approved)) {
      const valid = new Set(ask.items.map(item => item.index));
      return new Set(parsed.approved.filter((n): n is number => Number.isInteger(n) && valid.has(n as number)));
    }
  } catch { /* fallback below */ }
  return new Set(ask.items.map(item => item.index));
}

function fieldCollisions(fields: readonly ConnectorWriteField[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const lower = field.key.toLowerCase();
    counts.set(lower, (counts.get(lower) ?? 0) + 1);
  }
  return counts;
}

function inlinePreview(item: ConnectorBatchWriteItem): string {
  if (!item.fields.length) return "";
  const collisions = fieldCollisions(item.fields);
  return item.fields.slice(0, 2).map(field => {
    const label = connectorFieldLabel(field.key, field.label, collisions);
    const val = (field.preview ?? field.value).split("\n")[0]!.slice(0, 48);
    return `${label}: ${val}`;
  }).join(" · ");
}

function needsExpand(item: ConnectorBatchWriteItem): boolean {
  if (item.fields.length > 2) return true;
  return item.fields.some(field => Boolean(field.preview) || field.multiline || field.value.length > 48);
}

/** Single in-chat confirmation card for `connectors.batch` (A102):
 * displays shared parameters once, lets the owner inspect every item and uncheck individual items before
 * confirming in one click, and folds into an expandable summary pill once settled. */
export function ConnectorBatchWriteCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorBatchWrite: ConnectorBatchWriteAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorBatchWrite;
  const total = ask.items.length;
  const actionTitle = ask.sharedToolName && ask.sharedActionLabel
    ? connectorActionLabel(ask.sharedToolName, ask.sharedActionLabel)
    : t("connectorBatch.mixedAction");

  const [selected, setSelected] = useState<Set<number>>(() => new Set(ask.items.map(item => item.index)));
  const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({});
  const [expandedCommon, setExpandedCommon] = useState<Record<string, boolean>>({});
  const [settledOpen, setSettledOpen] = useState(false);
  const { busy, error, run } = useAction();

  const commonFields = ask.commonFields ?? [];
  const commonCollisions = fieldCollisions(commonFields);

  const renderFields = (fields: readonly ConnectorWriteField[], keyPrefix: string) => {
    const collisions = fieldCollisions(fields);
    return <div className="jv-write-meta">
      {fields.map(field => {
        const longVal = field.value.length > 140 || field.value.includes("\n");
        const expandKey = `${keyPrefix}:${field.key}`;
        const openVal = Boolean(expandedCommon[expandKey]);
        return <div key={field.key} className="jv-write-meta-row" data-multiline={longVal || undefined}>
          <span className="jv-write-meta-label" title={connectorFieldLabel(field.key, field.label, collisions)}>
            {connectorFieldLabel(field.key, field.label, collisions)}
          </span>
          {longVal
            ? <div className="jv-write-readonly-wrap">
                <pre className="jv-write-readonly-block" data-expanded={openVal || undefined}>{field.value}</pre>
                <button type="button" className="jv-connector-link-btn" onClick={() => setExpandedCommon(prev => ({ ...prev, [expandKey]: !openVal }))}>
                  {t(openVal ? "connectorCard.showLess" : "connectorCard.showMore")}
                </button>
              </div>
            : <span className="jv-write-meta-static" title={field.value}>{field.value}</span>}
        </div>;
      })}
    </div>;
  };

  if (question.state !== "pending") {
    const picked = question.answer?.selected[0];
    const confirmed = question.state === "answered" && picked === 0;
    const approvedSet = confirmed ? parseApprovedSet(ask, question.answer?.custom) : new Set<number>();
    const statusWord = confirmed
      ? (approvedSet.size === total
          ? t("connectorBatch.confirmedAll", { count: total })
          : t("connectorBatch.confirmedPartial", { selected: approvedSet.size, total }))
      : question.state === "ignored"
        ? t(question.expiredReason === "connector_disconnected"
            ? "connectorCard.disconnected"
            : question.expiredReason === "connector_revoked"
              ? "connectorCard.revoked"
              : "connectorCard.expired")
        : t("connectorCard.discarded");
    const accountSummary = ask.account && !ask.name.includes(ask.account) ? ask.account : null;
    const summaryParts = [statusWord, accountSummary, ask.summary || actionTitle].filter(Boolean);

    return <div className="jv-write-settled" data-state={question.state}>
      <button type="button" className="jv-write-pill" aria-expanded={settledOpen} aria-label={t("connectorCard.toggleDetails")} onClick={() => setSettledOpen(v => !v)}>
        <span className="jv-write-pill-icon"><ConnectorMark provider={ask.provider}/></span>
        <span className="jv-write-pill-kind">{ask.name}</span>
        <span className="jv-write-pill-summary">{summaryParts.join(" · ")}</span>
        <ChevronsUpDownIcon className="jv-write-pill-chevron" aria-hidden="true"/>
      </button>
      {settledOpen && <div className="jv-write-settled-body">
        {(ask.account || ask.summary || commonFields.length > 0) && <div className="jv-write-settled-meta">
          {ask.summary && <p className="jv-batch-settled-summary">{ask.summary}</p>}
          <div className="jv-write-meta">
            {ask.account && <div className="jv-write-meta-row">
              <span className="jv-write-meta-label">{t("connectorCard.account")}</span>
              <span className="jv-write-meta-static">{ask.account}</span>
            </div>}
            {commonFields.map(field => <div key={field.key} className="jv-write-meta-row">
              <span className="jv-write-meta-label">{connectorFieldLabel(field.key, field.label, commonCollisions)}</span>
              <span className="jv-write-meta-static" title={field.value}>{field.value}</span>
            </div>)}
          </div>
        </div>}
        <div className="jv-batch-settled-list">
          {ask.items.map(item => {
            const skipped = confirmed && !approvedSet.has(item.index);
            const preview = inlinePreview(item);
            return <div key={item.index} className="jv-batch-settled-item" data-skipped={skipped || undefined}>
              <div className="jv-batch-item-main">
                <span className="jv-batch-item-label">{item.label}</span>
                {!ask.sharedToolName && <span className="jv-batch-item-tool">{connectorActionLabel(item.toolName, item.actionLabel)}</span>}
                {skipped && <span className="jv-batch-item-skipped">{t("connectorBatch.skippedTag")}</span>}
              </div>
              {preview && <span className="jv-batch-item-preview" title={preview}>{preview}</span>}
            </div>;
          })}
        </div>
      </div>}
    </div>;
  }

  const selectedCount = selected.size;
  const allSelected = selectedCount === total;

  const toggleItem = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(ask.items.map(item => item.index)));
  };

  const confirm = () => {
    if (selectedCount === 0) return;
    const custom = allSelected
      ? undefined
      : JSON.stringify({ approved: ask.items.map(item => item.index).filter(index => selected.has(index)) });
    void run("confirm", async () => {
      onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [0], ...(custom ? { custom } : {}) }));
    });
  };

  const discard = () => void run("discard", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [1] }));
  });

  const pendingDetail = [
    t("connectorBatch.title", { action: actionTitle, count: total }),
    ask.account && !ask.name.includes(ask.account) ? ask.account : null,
  ].filter(Boolean).join(" · ");

  const confirmLabel = selectedCount === total
    ? t("connectorBatch.confirmCount", { count: total })
    : t("connectorBatch.confirmSubset", { selected: selectedCount, total });

  return <div className="jv-question jv-write-card jv-batch-card" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon"><ConnectorMark provider={ask.provider}/></span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{ask.name}</p>
        <p className="jv-question-detail">{pendingDetail}</p>
      </div>
    </div>

    <div className="jv-question-body">
      {ask.summary && <p className="jv-batch-summary">{ask.summary}</p>}

      {commonFields.length > 0 && <div className="jv-batch-common">
        <span className="jv-batch-common-title">{t("connectorBatch.commonFields")}</span>
        {renderFields(commonFields, "common")}
      </div>}

      <div className="jv-batch-toolbar">
        <span className="jv-batch-count">{t("connectorBatch.selectedCount", { selected: selectedCount, total })}</span>
        <button type="button" className="jv-connector-link-btn" disabled={busy} onClick={toggleAll}>
          {t(allSelected ? "connectorBatch.clearAll" : "connectorBatch.selectAll")}
        </button>
      </div>

      <div className="jv-batch-list" role="list">
        {ask.items.map(item => {
          const checked = selected.has(item.index);
          const open = Boolean(expandedItems[item.index]);
          const expandable = item.fields.length > 0 && (needsExpand(item) || !ask.sharedToolName);
          const preview = inlinePreview(item);
          return <div key={item.index} className="jv-batch-item" role="listitem" data-unchecked={!checked || undefined}>
            <div className="jv-batch-item-row">
              <label className="jv-batch-check-wrap">
                <input type="checkbox" className="jv-batch-checkbox" checked={checked} disabled={busy} onChange={() => toggleItem(item.index)}/>
                <span className="jv-batch-item-copy">
                  <span className="jv-batch-item-main">
                    <span className="jv-batch-item-label">{item.label}</span>
                    {!ask.sharedToolName && <span className="jv-batch-item-tool">{connectorActionLabel(item.toolName, item.actionLabel)}</span>}
                  </span>
                  {preview && !open && <span className="jv-batch-item-preview" title={preview}>{preview}</span>}
                </span>
              </label>
              {expandable && <button type="button" className="jv-batch-expand" aria-expanded={open}
                aria-label={t(open ? "connectorBatch.collapseItem" : "connectorBatch.expandItem")}
                onClick={() => setExpandedItems(prev => ({ ...prev, [item.index]: !open }))}>
                {open ? <ChevronDownIcon aria-hidden="true"/> : <ChevronRightIcon aria-hidden="true"/>}
              </button>}
            </div>
            {open && item.fields.length > 0 && <div className="jv-batch-item-details">
              {renderFields(item.fields, `item-${item.index}`)}
            </div>}
          </div>;
        })}
      </div>

      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={discard}>{t("connectorCard.discard")}</button>
      <button type="button" className="ui-button ui-primary" disabled={busy || selectedCount === 0} onClick={confirm}>{confirmLabel}</button>
    </div>
  </div>;
}
