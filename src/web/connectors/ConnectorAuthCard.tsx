import { useState } from "react";
import { CheckIcon, MinusIcon, PlugIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorAuthAsk, ConnectorAuthItem, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

function displayItemName(item: Pick<ConnectorAuthItem, "name" | "account">): string {
  return item.account && !item.name.includes(item.account) ? `${item.name} (${item.account})` : item.name;
}

function parseGrantedSlugs(customJson: string | null | undefined, items: readonly ConnectorAuthItem[]): Set<string> {
  if (!customJson) return new Set(items.map(item => item.slug));
  try {
    const parsed = JSON.parse(customJson) as { granted?: unknown };
    if (Array.isArray(parsed?.granted)) {
      return new Set(parsed.granted.filter((slug): slug is string => typeof slug === "string"));
    }
  } catch { /* fallback below */ }
  return new Set(items.map(item => item.slug));
}

/** Pure in-chat access grant card for `connectors.request` (A102):
 * lets the owner allow one or multiple connected connectors for this run only or always (matching `secrets.request`, A52).
 * Account sign-in and disconnection are managed exclusively in Settings → Connectors. */
export function ConnectorAuthCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorAuth: ConnectorAuthAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorAuth;
  const batchItems = ask.items && ask.items.length >= 2 ? ask.items : null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    new Set((batchItems ?? []).map(item => item.connectorId)),
  );
  const { busy, error, run } = useAction();

  const displayName = displayItemName(ask);

  const toggleId = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!batchItems) return;
    setSelectedIds(selectedIds.size === batchItems.length ? new Set() : new Set(batchItems.map(item => item.connectorId)));
  };

  const fulfil = (scope: "always" | "once") => {
    if (batchItems && selectedIds.size === 0) return;
    const ids = batchItems && selectedIds.size < batchItems.length
      ? batchItems.map(item => item.connectorId).filter(id => selectedIds.has(id))
      : undefined;
    void run(`fulfil:${scope}`, async () => {
      onSettled(await api.fulfilConnectorAuth(message.chatId, message.id, scope, ids));
    });
  };

  const decline = () => void run("decline", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  });

  if (question.state !== "pending") {
    const allowed = question.state === "answered";
    const once = question.answer?.selected[0] === 1;
    const grantedSlugs = batchItems && allowed ? parseGrantedSlugs(question.answer?.custom, batchItems) : null;
    const partialBatch = Boolean(batchItems && grantedSlugs && grantedSlugs.size < batchItems.length);
    const outcome = allowed
      ? partialBatch
        ? t(once ? "connectorCard.oncePartial" : "connectorCard.allowedPartial", { selected: grantedSlugs!.size, total: batchItems!.length })
        : t(once ? "request.outcome.once" : "request.outcome.allowed")
      : question.state === "dismissed"
        ? t("request.outcome.declined")
        : question.expiredReason === "connector_disconnected"
          ? t("connectorCard.disconnected")
          : question.expiredReason === "connector_revoked"
            ? t("connectorCard.revoked")
            : t("request.outcome.ignored");
    const settledTitle = batchItems
      ? (allowed && grantedSlugs
          ? batchItems.filter(item => grantedSlugs.has(item.slug)).map(item => item.name).join(" · ") || t("connectorCard.grantBatchTitle", { count: batchItems.length })
          : batchItems.map(item => item.name).join(" · "))
      : displayName;

    return <div className="jv-question jv-question-settled" data-state={question.state}>
      <div className="jv-question-head">
        <span className="jv-question-icon">{batchItems ? <PlugIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
        <div className="jv-question-heading">
          <p className="jv-question-title">{settledTitle}</p>
          <p className="jv-question-detail">{ask.purpose}</p>
        </div>
        <span className="jv-question-outcome">
          {allowed ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}
          <span>{outcome}</span>
        </span>
      </div>
    </div>;
  }

  const allSelected = batchItems ? selectedIds.size === batchItems.length : true;
  const allowDisabled = busy || (batchItems !== null && selectedIds.size === 0);

  return <div className="jv-question" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{batchItems ? <PlugIcon aria-hidden="true"/> : <ConnectorMark provider={ask.provider}/>}</span>
      <div className="jv-question-heading">
        <p className="jv-question-title">
          {batchItems
            ? t("connectorCard.grantBatchTitle", { count: batchItems.length })
            : t("connectorCard.grantTitle", { name: displayName })}
        </p>
        <p className="jv-question-detail">{ask.purpose}</p>
      </div>
    </div>

    {(batchItems || error) && <div className="jv-question-body">
      {batchItems && <>
        {batchItems.length >= 4 && <div className="jv-batch-toolbar">
          <span className="jv-batch-count">{t("connectorBatch.selectedCount", { selected: selectedIds.size, total: batchItems.length })}</span>
          <button type="button" className="jv-connector-link-btn" disabled={busy} onClick={toggleAll}>
            {t(allSelected ? "connectorBatch.clearAll" : "connectorBatch.selectAll")}
          </button>
        </div>}
        <div className="jv-batch-list" role="list">
          {batchItems.map(item => {
            const checked = selectedIds.has(item.connectorId);
            return <div key={item.connectorId} className="jv-batch-item" role="listitem" data-unchecked={!checked || undefined}>
              <div className="jv-batch-item-row">
                <label className="jv-batch-check-wrap jv-auth-check-wrap">
                  <input type="checkbox" className="jv-batch-checkbox" checked={checked} disabled={busy} onChange={() => toggleId(item.connectorId)}/>
                  <span className="jv-auth-item-mark"><ConnectorMark provider={item.provider}/></span>
                  <span className="jv-batch-item-copy">
                    <span className="jv-batch-item-label">{item.name}</span>
                    {item.account && !item.name.includes(item.account) && <span className="jv-batch-item-preview">{item.account}</span>}
                  </span>
                </label>
              </div>
            </div>;
          })}
        </div>
      </>}
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>}

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={decline}>{t("secretCard.decline")}</button>
      <button type="button" className="ui-button" disabled={allowDisabled} onClick={() => fulfil("once")}>{t("secretCard.once")}</button>
      <button type="button" className="ui-button ui-primary" disabled={allowDisabled} onClick={() => fulfil("always")}>{t("secretCard.always")}</button>
    </div>
  </div>;
}
