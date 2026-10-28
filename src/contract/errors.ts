/** Failures the server names with a code (A45) and the web words itself (web/errors.ts). A code thrown on the server
 * must be one of these, and every one must have its wording: both fail to compile otherwise. */
export type ErrorCode =
  | "agent_undeletable" | "autoconfig_model" | "autoconfig_source" | "bot_missing" | "chat_access_changed"
  | "computer_failed" | "computer_missing" | "connection_in_use" | "connection_missing" | "credential_changed"
  | "credential_scope" | "credential_unreadable" | "credentials_missing" | "data_locked" | "discovery_format"
  | "discovery_http" | "discovery_key" | "discovery_protocol" | "discovery_unreachable" | "discovery_url"
  | "discovery_url_missing" | "docker_unavailable" | "file_too_large" | "history_missing" | "invalid_credential" | "invalid_run"
  | "login_input" | "login_option" | "login_step" | "machine_missing" | "machine_name_taken" | "message_missing"
  | "model_incomplete" | "model_missing" | "model_request_failed" | "model_required" | "model_switch_uncertain"
  | "name_taken" | "provider_name_taken" | "question_closed" | "question_expired" | "reset_custom" | "runtime_failed"
  | "secret_description_invalid" | "secret_missing" | "secret_name_invalid" | "secret_name_taken"
  | "secret_value_missing" | "secret_value_too_long" | "session_corrupt" | "session_mismatch" | "session_missing"
  | "session_path" | "ssh_auth_failed" | "ssh_bad_directory" | "ssh_bad_host" | "ssh_bad_port" | "ssh_bad_user"
  | "ssh_failed" | "ssh_host_key_changed" | "ssh_key_expired" | "ssh_key_refused" | "ssh_key_unreadable"
  | "ssh_password_missing" | "ssh_password_refused" | "ssh_unreachable" | "ssh_unsupported" | "stopping"
  | "task_invalid" | "task_schedule_invalid" | "task_time_past" | "thinking_format" | "tools_missing" | "unsafe_replay";
/** Values a failure's wording fills in. */
export type ErrorParams = Record<string, string | number>;
