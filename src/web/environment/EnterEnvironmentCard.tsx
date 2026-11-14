import { BoxIcon, ServerIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type EnterAsk, type Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { RequestCard, SettledRequest } from "../question/RequestCard";

/** A request by the agent Bot to enter another Bot's sandbox or an ungranted SSH machine (environments.enter, A93):
 * the target's name as the title and the Bot's purpose under it; 拒绝, 仅限本次 and 始终允许 in the footer. */
export function EnterEnvironmentCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { enter: EnterAsk } }; onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question, ask = question.enter;
  const target = ask.kind === "sandbox" ? t("envs.sandboxOf", { name: ask.name }) : ask.name;
  const { busy, error, run: perform } = useAction();
  if (question.state !== "pending") {
    const text = question.state !== "answered" ? t(question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored")
      : t(question.answer?.selected[0] === 1 ? "request.outcome.once" : "request.outcome.allowed");
    return <SettledRequest icon={ask.kind === "sandbox" ? <BoxIcon aria-hidden="true"/> : <ServerIcon aria-hidden="true"/>} title={target} state={question.state} text={text} purpose={ask.purpose}/>;
  }
  const run = (action: () => Promise<ChatMessage>) => {
    if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed");
  };
  const allow = (option: number) => run(() => api.answerQuestion(message.chatId, message.id, { action: "answer", selected: [option] }));
  return <RequestCard icon={ask.kind === "sandbox" ? <BoxIcon aria-hidden="true"/> : <ServerIcon aria-hidden="true"/>}
    title={target} purpose={ask.purpose} label={t("enterCard.title", { name: target })}
    busy={busy} error={error} ready decline={t("secretCard.decline")} confirm={t("secretCard.always")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => allow(0)} once={{ label: t("secretCard.once"), onClick: () => allow(1) }}>
    {ask.address && <p className="jv-machine-where"><code>{ask.address}</code></p>}
  </RequestCard>;
}
