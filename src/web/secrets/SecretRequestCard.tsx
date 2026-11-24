import { useState } from "react";
import { KeyRoundIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type Question, type SecretAsk } from "../../contract/chat";
import { type SecretCategory } from "../../contract/secrets";
import { t } from "../i18n";
import { useAction } from "../action";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";
import {
  SecretFieldsEditor, fieldsDraftReady, remapDraftCategory, serializeFieldsDraft, toFieldsDraft, type SecretFieldsDraft,
} from "./SecretFieldsEditor";
import {
  SecretCategoryIcon, SecretCategoryPicker, fieldDisplayLabel, secretCategoryLabel, secretPrimaryLabel,
} from "./category";
import "../styles/secrets.css";

/** A Bot's request for a secret (secrets.request, A52), in the request panel (RequestCard): the key's name and purpose
 * in the header; category template + extensible public/secret fields (editable when creating a new secret, read-only
 * context when already saved) and the masked primary value in the body; 拒绝, 仅限本次 and 始终允许 in the footer. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const initialCategory: SecretCategory = ask.category ?? "api_key";
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [category, setCategory] = useState<SecretCategory>(initialCategory);
  const [fieldsDraft, setFieldsDraft] = useState<SecretFieldsDraft>(() => toFieldsDraft(initialCategory, ask.fields, false));
  const { busy, error, run: perform } = useAction();

  if (question.state !== "pending") {
    const text = question.state !== "answered" ? t(question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored")
      : t(question.answer?.selected[0] === 1 ? "request.outcome.once" : "request.outcome.allowed");
    return <SettledRequest icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} state={question.state} text={text} purpose={ask.purpose}/>;
  }

  const needsValue = ask.needsValue || replacing, short = value.length > 0 && value.length < 8;
  const creating = !ask.exists;
  const savedFields = ask.fields ?? [];
  const hasSavedContext = ask.exists && Boolean(savedFields.length > 0 || (ask.category && ask.category !== "other"));

  const changeCategory = (next: SecretCategory) => {
    setFieldsDraft(prev => remapDraftCategory(category, next, prev));
    setCategory(next);
  };

  const ready = (!needsValue || !!value) && (!creating || fieldsDraftReady(fieldsDraft));
  const run = (action: () => Promise<ChatMessage>) => { if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed"); };
  const allow = (scope: "always" | "once") => run(() => api.fulfilSecret(message.chatId, message.id, {
    scope,
    ...(needsValue ? { value } : {}),
    ...(creating ? { category, fields: serializeFieldsDraft(category, fieldsDraft) } : {}),
  }));

  return <RequestCard icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} titleClass="jv-secret-request-name" purpose={ask.purpose}
    label={t("secretCard.title", { name: ask.name })} busy={busy} error={error} ready={ready}
    decline={t("secretCard.decline")} confirm={t("secretCard.always")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => allow("always")} once={{ label: t("secretCard.once"), onClick: () => allow("once") }}>
    {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
    {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
      <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
    {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
    {hasSavedContext && <div className="jv-secret-request-context">
      {ask.category && <span className="jv-secret-context-chip"><SecretCategoryIcon category={ask.category}/><span>{secretCategoryLabel(ask.category)}</span></span>}
      {savedFields.map(field => field.secret
        ? <span key={field.key} className="jv-secret-context-chip"><LockIcon aria-hidden="true"/><span className="jv-mono">{field.key}</span></span>
        : field.value
          ? <span key={field.key} className="jv-secret-context-chip" title={`${fieldDisplayLabel(field)}: ${field.value}`}>
              <span>{fieldDisplayLabel(field)}: {field.value}</span>
            </span>
          : null)}
    </div>}
    {creating && <div className="jv-secret-request-meta">
      <SecretCategoryPicker value={category} onChange={changeCategory} disabled={busy} compact/>
      <SecretFieldsEditor category={category} draft={fieldsDraft} onChange={setFieldsDraft} disabled={busy} compact/>
    </div>}
    {needsValue && <MaskedField label={secretPrimaryLabel(category)} value={value} visible={visible} disabled={busy} autoFocus placeholder={t("secretCard.valuePlaceholder")}
      hint={t(short ? "secrets.shortValue" : "secretCard.valueHint")} short={short} onChange={setValue} onVisible={setVisible}/>}
  </RequestCard>;
}
