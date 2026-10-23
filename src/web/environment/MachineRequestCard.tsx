import { useState } from "react";
import { ServerIcon, TriangleAlertIcon } from "lucide-react";
import { ApiError, api, type ChatMessage, type MachineAsk, type Question } from "../api";
import { t } from "../i18n";
import { useAction } from "../action";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";
import { MachineKeyLine, usePreparedKey, type MachineLogin } from "./MachineKey";
import "../styles/machines.css";

/** A Bot's request for an SSH machine (environments.request, A57, A59), in the request panel (RequestCard): the
 * machine's name and the Bot's purpose in the header; its address, the fingerprint to check and the password — or
 * Jarvy's public key for the owner to add themselves — in the body (only a grant for a machine already added); 拒绝 and
 * 连接并添加 in the footer. The password goes to its own endpoint and never enters the chat. A wrong password leaves the
 * card open to try again. Settled, it folds to one line. */
export function MachineRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { machine: MachineAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.machine;
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), { busy, error, setError, run: perform } = useAction();
  const [login, setLogin] = useState<MachineLogin>("password");
  const prepared = usePreparedKey(question.state === "pending" && !ask.existing && login === "key");
  const address = `${ask.user}@${ask.host}${ask.port === 22 ? "" : `:${ask.port}`}`;
  if (question.state !== "pending") {
    const text = t(question.state === "answered" ? (ask.existing ? "machineCard.granted" : "machineCard.added") : question.state === "dismissed" ? "machineCard.declined" : "machineCard.ignored", { name: ask.name });
    return <SettledRequest state={question.state} text={text} purpose={ask.purpose}/>;
  }
  const run = (action: () => Promise<ChatMessage>) => {
    if (!busy) void perform("answer", async () => {
      try { onSettled(await action()); } catch (reason) { if (reason instanceof ApiError && reason.code === "ssh_key_expired") prepared.renew(); throw reason; }
    }, "question.failed");
  };
  const needsAnswer = !ask.existing, ready = !needsAnswer || (login === "key" ? !!prepared.key : !!password);
  return <RequestCard icon={<ServerIcon aria-hidden="true"/>} title={ask.name} purpose={ask.purpose} label={t("machineCard.title", { name: ask.name })}
    busy={busy} error={error} ready={ready} decline={t("machineCard.decline")}
    confirm={t(!needsAnswer ? "machineCard.allow" : login === "key" ? (busy ? "machines.verifying" : "machines.verify") : busy ? "machines.connecting" : "machineCard.add")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => run(() => api.fulfilMachine(message.chatId, message.id, login === "key" && prepared.key ? { keyId: prepared.key.keyId } : { password }))}>
    <p className="jv-machine-where"><code>{address}</code>{ask.directory && <code>{ask.directory}</code>}</p>
    {ask.existing ? <p className="jv-secret-request-note">{t("machineCard.existing")}</p> : <>
      {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
      <div className="jv-machine-card-field"><span>{t("machines.fingerprint")}</span>
        <div className="jv-machine-prints">{ask.hostKeys.fingerprints.map(print => <code key={print}>{print}</code>)}</div>
        <small>{t("machines.fingerprintHint")}</small></div>
      <div className="jv-secret-request-seg" role="radiogroup" aria-label={t("machines.login")}>
        {(["password", "key"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={login === item} disabled={busy}
          onClick={() => { setLogin(item); setError(""); }}>{t(item === "password" ? "machines.byPassword" : "machines.byKey")}</button>)}
      </div>
      {login === "password" ? <MaskedField label={t("machines.password")} value={password} visible={visible} disabled={busy} hint={t("machines.passwordHint")}
        onChange={setPassword} onVisible={setVisible}/>
        : <div className="jv-machine-card-field"><span>{t("machines.publicKey")}</span>
          {prepared.key ? <MachineKeyLine publicKey={prepared.key.publicKey}/> : prepared.error ? <p className="jv-question-error" role="alert">{prepared.error}</p> : <small>…</small>}
          <small>{t("machines.keyHint", { user: ask.user })}</small></div>}
    </>}
  </RequestCard>;
}
