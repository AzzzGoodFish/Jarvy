import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, KeyRoundIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type Question, type SecretAsk } from "../../contract/chat";
import { type SecretCategory } from "../../contract/secrets";
import { t } from "../i18n";
import { useAction } from "../action";
import { Input } from "../components/ui/input";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";
import {
  SecretFieldsEditor, fieldsDraftReady, remapDraftCategory, serializeFieldsDraft, toFieldsDraft, type SecretFieldsDraft,
} from "./SecretFieldsEditor";
import {
  SecretCategoryIcon, SecretCategoryPicker, fieldDisplayLabel, secretCategoryLabel, secretPrimaryLabel,
} from "./category";
import "../styles/secrets.css";

/** A Bot's request for a secret (secrets.request, A52), in the request panel (RequestCard):
 * keeps the default view focused on entering only the necessary secret value(s) while summarizing Bot-supplied
 * category/public fields in a compact strip; full editing (category, description, built-in and custom fields)
 * opens on demand via the disclosure toggle. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const initialCategory: SecretCategory = ask.category ?? "other";
  const initialDescription = ask.purpose.replace(/\s+/g, " ").slice(0, 200);
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [category, setCategory] = useState<SecretCategory>(initialCategory);
  const [description, setDescription] = useState(initialDescription);
  const [fieldsDraft, setFieldsDraft] = useState<SecretFieldsDraft>(() => toFieldsDraft(initialCategory, ask.fields, false));
  const [editingDetails, setEditingDetails] = useState(false);
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

  const updateSecretField = (id: string, patch: { value?: string; visible?: boolean }) => {
    setFieldsDraft(prev => ({
      ...prev,
      custom: prev.custom.map(item => item.id === id ? { ...item, ...patch } : item),
    }));
  };

  // Current public summary chips for the collapsed creating view (reflects Bot hints and any owner edits).
  const currentFields = creating ? serializeFieldsDraft(category, fieldsDraft) : [];
  const publicPreviewFields = currentFields.filter(field => !field.secret && field.value);
  const requiredCustomSecrets = creating ? fieldsDraft.custom.filter(field => field.secret && field.key.trim()) : [];
  const showCategoryChip = Boolean(ask.category || category !== "other" || publicPreviewFields.length > 0);

  const ready = (!needsValue || !!value) && (!creating || fieldsDraftReady(fieldsDraft));
  const run = (action: () => Promise<ChatMessage>) => { if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed"); };
  const allow = (scope: "always" | "once") => run(() => api.fulfilSecret(message.chatId, message.id, {
    scope,
    ...(needsValue ? { value } : {}),
    ...(creating ? {
      category,
      fields: serializeFieldsDraft(category, fieldsDraft),
      ...(description.trim() !== initialDescription ? { description: description.trim() } : {}),
    } : {}),
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

    {creating && <div className="jv-secret-request-summary">
      <div className="jv-secret-request-context">
        {showCategoryChip && <span className="jv-secret-context-chip">
          <SecretCategoryIcon category={category}/><span>{secretCategoryLabel(category)}</span>
        </span>}
        {publicPreviewFields.map(field => <span key={field.key} className="jv-secret-context-chip" title={`${fieldDisplayLabel(field)}: ${field.value}`}>
          <span>{fieldDisplayLabel(field)}: {field.value}</span>
        </span>)}
      </div>
      <button type="button" className="jv-secret-request-edit-toggle" aria-expanded={editingDetails} disabled={busy}
        onClick={() => setEditingDetails(v => !v)}>
        {editingDetails ? <ChevronDownIcon aria-hidden="true"/> : <ChevronRightIcon aria-hidden="true"/>}
        <span>{t(editingDetails ? "secretCard.hideDetails" : "secretCard.editDetails")}</span>
      </button>
    </div>}

    {creating && editingDetails && <div className="jv-secret-request-meta">
      <SecretCategoryPicker value={category} onChange={changeCategory} disabled={busy} compact/>
      <label className="jv-field"><span>{t("secrets.description")}</span>
        <Input maxLength={200} disabled={busy} placeholder={t("secrets.descriptionPlaceholder")}
          value={description} onChange={event => setDescription(event.target.value)}/>
      </label>
      <SecretFieldsEditor category={category} draft={fieldsDraft} onChange={setFieldsDraft} disabled={busy} compact/>
    </div>}

    {needsValue && <MaskedField label={secretPrimaryLabel(category)} value={value} visible={visible} disabled={busy} autoFocus placeholder={t("secretCard.valuePlaceholder")}
      hint={t(short ? "secrets.shortValue" : "secretCard.valueHint")} short={short} onChange={setValue} onVisible={setVisible}/>}

    {creating && !editingDetails && requiredCustomSecrets.map(field => {
      const fieldShort = field.value.length > 0 && field.value.length < 8;
      return <MaskedField key={field.id} label={fieldDisplayLabel(field)} value={field.value}
        visible={Boolean(field.visible)} disabled={busy} placeholder={t("secrets.fieldSecretValuePlaceholder")}
        hint={fieldShort ? t("secrets.shortValue") : ""} short={fieldShort}
        onChange={val => updateSecretField(field.id, { value: val })}
        onVisible={vis => updateSecretField(field.id, { visible: vis })}/>;
    })}
  </RequestCard>;
}
