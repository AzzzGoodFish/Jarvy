import { useState } from "react";
import { GlobeIcon, KeyRoundIcon, TriangleAlertIcon, UserIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type Question, type SecretAsk } from "../../contract/chat";
import { type SecretCategory } from "../../contract/secrets";
import { t } from "../i18n";
import { useAction } from "../action";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";
import { SecretCategoryIcon, SecretCategoryPicker, secretCategoryLabel, secretPlaceholders } from "./category";
import "../styles/secrets.css";

/** A Bot's request for a secret (secrets.request, A52), in the request panel (RequestCard): the key's name and purpose
 * in the header; optional category/website/username metadata (editable when creating a new secret, read-only context
 * when already saved) and the masked value in the body; 拒绝, 仅限本次 and 始终允许 in the footer. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [category, setCategory] = useState<SecretCategory>(ask.category ?? "api_key");
  const [url, setUrl] = useState(ask.url ?? "");
  const [username, setUsername] = useState(ask.username ?? "");
  const { busy, error, run: perform } = useAction();

  if (question.state !== "pending") {
    const text = question.state !== "answered" ? t(question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored")
      : t(question.answer?.selected[0] === 1 ? "request.outcome.once" : "request.outcome.allowed");
    return <SettledRequest icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} state={question.state} text={text} purpose={ask.purpose}/>;
  }

  const needsValue = ask.needsValue || replacing, short = value.length > 0 && value.length < 8;
  const creating = !ask.exists;
  const hints = secretPlaceholders(category);
  const hasSavedContext = ask.exists && Boolean(ask.url || ask.username || (ask.category && ask.category !== "other"));

  const run = (action: () => Promise<ChatMessage>) => { if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed"); };
  const allow = (scope: "always" | "once") => run(() => api.fulfilSecret(message.chatId, message.id, {
    scope,
    ...(needsValue ? { value } : {}),
    ...(creating ? { category, url: url.trim(), username: username.trim() } : {}),
  }));

  return <RequestCard icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} titleClass="jv-secret-request-name" purpose={ask.purpose}
    label={t("secretCard.title", { name: ask.name })} busy={busy} error={error} ready={!needsValue || !!value}
    decline={t("secretCard.decline")} confirm={t("secretCard.always")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => allow("always")} once={{ label: t("secretCard.once"), onClick: () => allow("once") }}>
    {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
    {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
      <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
    {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
    {hasSavedContext && <div className="jv-secret-request-context">
      {ask.category && <span className="jv-secret-context-chip"><SecretCategoryIcon category={ask.category}/><span>{secretCategoryLabel(ask.category)}</span></span>}
      {ask.url && <span className="jv-secret-context-chip" title={ask.url}><GlobeIcon aria-hidden="true"/><span>{ask.url}</span></span>}
      {ask.username && <span className="jv-secret-context-chip" title={ask.username}><UserIcon aria-hidden="true"/><span>{ask.username}</span></span>}
    </div>}
    {creating && <div className="jv-secret-request-meta">
      <SecretCategoryPicker value={category} onChange={setCategory} disabled={busy} compact/>
      <div className="jv-secret-request-meta-grid">
        <label className="jv-field jv-secret-request-value"><span>{t("secrets.url")}</span>
          <div className="jv-secret-request-field"><input maxLength={300} disabled={busy} placeholder={hints.url} value={url} onChange={event => setUrl(event.target.value)}/></div>
        </label>
        <label className="jv-field jv-secret-request-value"><span>{t("secrets.username")}</span>
          <div className="jv-secret-request-field"><input maxLength={160} disabled={busy} placeholder={hints.username} value={username} onChange={event => setUsername(event.target.value)}/></div>
        </label>
      </div>
    </div>}
    {needsValue && <MaskedField label={t("secretCard.value")} value={value} visible={visible} disabled={busy} autoFocus placeholder={t("secretCard.valuePlaceholder")}
      hint={t(short ? "secrets.shortValue" : "secretCard.valueHint")} short={short} onChange={setValue} onVisible={setVisible}/>}
  </RequestCard>;
}
