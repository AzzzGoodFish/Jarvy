import { ApiError, type BotStatus } from "./api";
import { t, type Key } from "./i18n";

/** Failures the server names with a code (A45), worded here. scripts/check-i18n.mjs keeps this table and the
 * server's codes in step: a code thrown there must be here, and an entry here must still be thrown there. */
const ERROR_KEYS: Record<string, Key> = {
  agent_undeletable: "error.agentUndeletable", autoconfig_model: "error.autoconfigModel", autoconfig_source: "error.autoconfigSource",
  bot_missing: "error.botMissing", chat_access_changed: "error.chatAccessChanged",
  computer_failed: "error.computerFailed", computer_missing: "error.computerMissing", docker_unavailable: "error.dockerUnavailable",
  connection_missing: "error.connectionMissing", credential_changed: "error.credentialChanged", credential_unreadable: "error.credentialUnreadable", credential_scope: "error.credentialScope",
  credentials_missing: "error.credentialsMissing", data_locked: "error.dataLocked",
  discovery_format: "error.discoveryFormat", discovery_http: "error.discoveryHttp", discovery_key: "error.discoveryKey",
  discovery_protocol: "error.discoveryProtocol", discovery_url: "error.discoveryUrl", discovery_url_missing: "error.discoveryUrlMissing", discovery_unreachable: "error.discoveryUnreachable",
  history_missing: "error.historyMissing", invalid_credential: "error.invalidCredential", invalid_run: "error.invalidRun",
  login_input: "error.loginInput", login_option: "error.loginOption", login_step: "error.loginStep",
  message_missing: "error.messageMissing", model_incomplete: "error.modelIncomplete", model_missing: "error.modelMissing",
  model_request_failed: "error.modelRequestFailed", model_required: "error.modelRequired", model_switch_uncertain: "error.modelSwitchUncertain",
  name_taken: "error.nameTaken", provider_name_taken: "error.providerNameTaken",
  question_closed: "error.questionClosed", question_expired: "error.questionExpired",
  secret_description_invalid: "error.secretDescriptionInvalid", secret_missing: "error.secretMissing", secret_name_invalid: "error.secretNameInvalid",
  secret_name_taken: "error.secretNameTaken", secret_value_missing: "error.secretValueMissing", secret_value_too_long: "error.secretValueTooLong",
  runtime_failed: "error.runtimeFailed", session_corrupt: "error.sessionCorrupt", session_mismatch: "error.sessionMismatch",
  session_missing: "error.sessionMissing", session_path: "error.sessionPath", stopping: "error.stopping",
  task_chat_missing: "error.taskChatMissing", task_chat_unknown: "error.taskChatUnknown", task_invalid: "error.taskInvalid",
  task_schedule_invalid: "error.taskScheduleInvalid", task_time_past: "error.taskTimePast",
  thinking_format: "error.thinkingFormat", tools_missing: "error.toolsMissing", unsafe_replay: "error.unsafeReplay",
};
const worded = (code: string | null | undefined, params?: Record<string, string | number>) => {
  const key = code ? ERROR_KEYS[code] : undefined;
  return key ? t(key, params) : null;
};

/** What to tell a person about a failure: the coded sentence; else the server's own words for a 4xx; else `fallback`. */
export function errorText(reason: unknown, fallback: Key = "common.failed"): string {
  if (reason instanceof ApiError) return worded(reason.code, reason.params) ?? (reason.status < 500 ? reason.message : t(fallback));
  return reason instanceof Error && reason.message ? reason.message : t(fallback);
}
/** A Bot's last run error, worded. */
export const statusError = (status: BotStatus) => worded(status.errorCode, status.errorParams) ?? status.error ?? "";
