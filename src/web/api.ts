import type { Bot, BotStatus } from "../contract/bots";
import type { Attachment, Chat, ChatMessage, Member, SearchResult, Section, ThreadEntry } from "../contract/chat";
import type { ConnectionInfo } from "../contract/connection";
import type { HostKeys, SshMachine } from "../contract/environment";
import type { AutoconfigResult, BotColor, BotModelGroup, ConfiguredModel, LoginState, ModelConnection, ModelInput, ModelResetPlan, ProviderOption } from "../contract/models";
import type { Secret, SecretUse } from "../contract/secrets";
import type { Task, TaskInput } from "../contract/tasks";
import { t } from "./i18n";
/** A failed request. `code` and `params` (A45) name a failure the interface words itself (errors.ts); the message is
 * the server's English, shown only when there is no code. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly params?: Record<string, string | number>) { super(message); }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, credentials: "same-origin", headers: {
    ...(init.body && !(init.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), ...init.headers,
  } }); } catch { throw new Error(t("api.offline")); }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(response.status, body);
  return body as T;
}
const failure = (status: number, body: unknown) => {
  const value = typeof body === "object" && body !== null ? body as { error?: unknown; code?: unknown; params?: Record<string, string | number> } : {};
  return new ApiError(status, value.error === undefined ? `HTTP ${status}` : String(value.error), typeof value.code === "string" ? value.code : undefined, value.params);
};
/** Uploads one attachment; fetch cannot report upload progress, so this one goes through XMLHttpRequest and tells
 * `onProgress` how much of the file has gone out (0–1). Aborting `signal` stops it and rejects with an AbortError. */
function upload(chatId: string, file: File, onProgress?: (done: number) => void, signal?: AbortSignal) {
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (signal?.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.open("POST", `/api/chats/${chatId}/attachments`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    xhr.onerror = () => reject(new Error(t("api.offline")));
    xhr.onload = () => {
      let body: unknown = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON: the status speaks */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Attachment); else reject(failure(xhr.status, body));
    };
    xhr.send(file);
  });
}
/** Every message after a sequence (default: all), page by page. */
async function readChatMessages(id: string, from = 0): Promise<{ messages: ChatMessage[] }> {
  const messages: ChatMessage[] = [];
  let after = from;
  while (true) {
    const page = await request<{ messages: ChatMessage[]; nextSequence: number; hasMore: boolean }>(`/chats/${id}/messages?after=${after}&limit=1000`);
    messages.push(...page.messages);
    if (!page.hasMore) return { messages };
    if (page.nextSequence <= after) throw new Error(t("api.historyFailed"));
    after = page.nextSequence;
  }
}
const body = (value: unknown) => JSON.stringify(value);
export const api = {
  me: () => request<{ username: string }>("/me"),
  /** The search box: channels and threads by title / topic / notice, messages by text with their chat; `within` searches one chat (a channel with its threads). */
  search: (query: string, within?: string) => request<SearchResult>(`/search?q=${encodeURIComponent(query)}${within ? `&in=${within}` : ""}&limit=60`),
  login: (username: string, password: string) => request<{ username: string }>("/login", { method: "POST", body: body({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/logout", { method: "POST" }),
  bots: () => request<{ bots: Bot[] }>("/bots"),
  createBot: (name: string) => request<Bot>("/bots", { method: "POST", body: body({ name }) }),
  saveBot: (id: string, update: Pick<Bot, "name" | "description" | "systemPrompt">) => request<Bot>(`/bots/${id}`, { method: "PUT", body: body(update) }),
  modelOptions: () => request<{ connections: BotModelGroup[] }>("/model-options"),
  /** `language`: the interface language; the agent Bot's first model has it welcome the owner in it (A48). */
  selectBotModel: (id: string, connectionId: string, modelId: string, thinkingLevel: string, language: string) => request<Bot>(`/bots/${id}/model`, { method: "PUT", body: body({ connectionId, modelId, thinkingLevel, language }) }),
  answerQuestion: (chatId: string, messageId: string, answer: { action: "answer"; selected: number[]; custom?: string } | { action: "dismiss" }) =>
    request<ChatMessage>(`/chats/${chatId}/questions/${messageId}`, { method: "POST", body: body(answer) }),
  setBotColor: (id: string, color: BotColor) => request<Bot>(`/bots/${id}/color`, { method: "PUT", body: body({ color }) }),
  chats: () => request<{ chats: Chat[] }>("/chats"),
  createChat: (botId: string) => request<Chat>("/chats", { method: "POST", body: body({ botId }) }),
  deleteChat: (id: string) => request<{ ok: boolean }>(`/chats/${id}`, { method: "DELETE" }),
  members: () => request<{ members: Member[] }>("/members"),
  sections: () => request<{ sections: Section[] }>("/sections"),
  createSection: (input: { name: string }) => request<Section>("/sections", { method: "POST", body: body(input) }),
  updateSection: (id: string, input: { name?: string; position?: number }) => request<Section>(`/sections/${id}`, { method: "PATCH", body: body(input) }),
  deleteSection: (id: string) => request<{ ok: boolean }>(`/sections/${id}`, { method: "DELETE" }),
  createChannel: (input: { name: string; topic?: string; sectionId: string | null; memberIds: string[] }) => request<Chat>("/channels", { method: "POST", body: body(input) }),
  updateChannel: (id: string, input: { name?: string; topic?: string; sectionId?: string | null }) => request<Chat>(`/chats/${id}`, { method: "PATCH", body: body(input) }),
  addMember: (id: string, memberId: string) => request<Chat>(`/chats/${id}/members`, { method: "POST", body: body({ memberId }) }),
  removeMember: (id: string, memberId: string) => request<Chat>(`/chats/${id}/members/${memberId}`, { method: "DELETE" }),
  setNote: (id: string, text: string) => request<Chat>(`/chats/${id}/note`, { method: "PUT", body: body({ text }) }),
  markRead: (id: string, sequence: number) => request<{ readSequence: number }>(`/chats/${id}/read`, { method: "POST", body: body({ sequence }) }),
  messages: readChatMessages,
  /** Scrolling back: the newest `limit` messages, or the `limit` before a sequence. */
  latestMessages: (id: string, limit: number) => request<{ messages: ChatMessage[]; hasOlder: boolean }>(`/chats/${id}/messages?tail=${limit}`),
  olderMessages: (id: string, before: number, limit: number) => request<{ messages: ChatMessage[]; hasOlder: boolean }>(`/chats/${id}/messages?before=${before}&limit=${limit}`),
  send: (id: string, content: string, attachmentIds: string[], clientMessageId: string, alsoToChannel = false, replyTo?: string, quotes: { messageId: string; text: string }[] = []) =>
    request<ChatMessage>(`/chats/${id}/messages`, { method: "POST", body: body({ content, attachmentIds, clientMessageId, ...(alsoToChannel ? { alsoToChannel } : {}), ...(replyTo ? { replyTo } : {}), ...(quotes.length ? { quotes } : {}) }) }),
  /** Emoji marks (A39) and pins. */
  fold: (messageId: string, folded: boolean) => request<ChatMessage>(`/messages/${messageId}/fold`, { method: "PUT", body: body({ folded }) }),
  react: (messageId: string, emoji: string, on: boolean) => request<ChatMessage>(`/messages/${messageId}/reaction`, { method: "PUT", body: body({ emoji, on }) }),
  pin: (id: string, pinned: boolean) => request<Chat>(`/chats/${id}/pin`, { method: "PUT", body: body({ pinned }) }),
  mute: (id: string, muted: boolean) => request<Chat>(`/chats/${id}/mute`, { method: "PUT", body: body({ muted }) }),
  deleteBot: (botId: string, deleteFiles: boolean) => request<{ ok: boolean }>(`/bots/${botId}${deleteFiles ? "?files=delete" : ""}`, { method: "DELETE" }),
  chat: (id: string) => request<Chat>(`/chats/${id}`),
  message: (id: string) => request<ChatMessage>(`/messages/${id}`),
  openThread: (messageId: string) => request<Chat>(`/messages/${messageId}/thread`, { method: "POST" }),
  channelThreads: (channelId: string) => request<{ threads: ThreadEntry[] }>(`/chats/${channelId}/threads`),
  followedThreads: () => request<{ threads: ThreadEntry[] }>("/threads"),
  updateThread: (id: string, change: { title?: string; status?: "open" | "done" }) => request<Chat>(`/chats/${id}`, { method: "PATCH", body: body(change) }),
  follow: (id: string, following: boolean) => request<Chat>(`/chats/${id}/follow`, { method: "PUT", body: body({ following }) }),
  /** A Bot's DMs with other Bots (read-only) and the channels / threads it subscribed to. */
  botDirects: (botId: string) => request<{ chats: Chat[] }>(`/members/${botId}/dms`),
  tasks: (botId: string) => request<{ tasks: Task[] }>(`/bots/${botId}/tasks`),
  createTask: (botId: string, input: TaskInput) => request<Task>(`/bots/${botId}/tasks`, { method: "POST", body: body(input) }),
  updateTask: (botId: string, id: string, input: TaskInput) => request<Task>(`/bots/${botId}/tasks/${id}`, { method: "PUT", body: body(input) }),
  setTaskOn: (botId: string, id: string, on: boolean) => request<Task>(`/bots/${botId}/tasks/${id}/${on ? "resume" : "pause"}`, { method: "POST" }),
  deleteTask: (botId: string, id: string) => request<{ ok: true }>(`/bots/${botId}/tasks/${id}`, { method: "DELETE" }),
  botSubscriptions: (botId: string) => request<{ chats: Chat[] }>(`/members/${botId}/subscriptions`),
  controlBot: (id: string, action: "start" | "stop" | "abort") => request<BotStatus>(`/bots/${id}/${action}`, { method: "POST" }),
  grantHost: (id: string, granted: boolean) => request<Bot>(`/bots/${id}/environment`, { method: "PUT", body: body({ hostGranted: granted }) }),
  grantBotMachine: (id: string, machineId: string, granted: boolean) => request<Bot>(`/bots/${id}/environment`, { method: "PUT", body: body({ machineId, granted }) }),
  /** The owner's SSH machines (A57, A59); private keys and kept passwords never come back. */
  machines: () => request<{ machines: SshMachine[] }>("/environments"),
  scanMachine: (input: { host: string; port: number; user: string }) => request<HostKeys>("/environments/scan", { method: "POST", body: body(input) }),
  /** `keyId`: a key from prepareMachineKey the owner added to the machine, instead of the password (A59). */
  addMachine: (input: { name: string; host: string; port: number; user: string; directory: string; description?: string; password?: string; keyId?: string; hostKeys: HostKeys }) =>
    request<SshMachine>("/environments", { method: "POST", body: body(input) }),
  prepareMachineKey: () => request<{ keyId: string; publicKey: string }>("/environments/keys", { method: "POST" }),
  setMachinePassword: (id: string, password: string) => request<SshMachine>(`/environments/${id}/password`, { method: "PUT", body: body({ password }) }),
  updateMachine: (id: string, input: { name?: string; directory?: string; description?: string }) => request<SshMachine>(`/environments/${id}`, { method: "PUT", body: body(input) }),
  checkMachine: (id: string) => request<{ hostKeys: HostKeys; changed: boolean; machine: SshMachine }>(`/environments/${id}/check`, { method: "POST" }),
  trustMachine: (id: string, fingerprints: string[]) => request<SshMachine>(`/environments/${id}/trust`, { method: "POST", body: body({ fingerprints }) }),
  deleteMachine: (id: string, force = false) => request<{ ok: boolean }>(`/environments/${id}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  grantMachine: (id: string, botId: string, granted: boolean) => request<SshMachine>(`/environments/${id}/grants/${botId}`, { method: "PUT", body: body({ granted }) }),
  fulfilMachine: (chatId: string, messageId: string, answer: { password: string } | { keyId: string }) =>
    request<ChatMessage>(`/environments/requests/${chatId}/${messageId}`, { method: "POST", body: body(answer) }),
  computer: (id: string, action: "start" | "stop" | "reset") => request<Bot>(`/bots/${id}/computer/${action}`, { method: "POST" }),
  /** How Jarvy is reached (A51): its HTTPS addresses, certificate fingerprint, and whether plain HTTP from other machines is allowed. */
  connection: () => request<ConnectionInfo>("/connection"),
  setConnection: (allowHttp: boolean) => request<ConnectionInfo>("/connection", { method: "PUT", body: body({ allowHttp }) }),
  /** The owner's secrets (A52); values go in and never come back. */
  secrets: () => request<{ secrets: Secret[]; keyLocation: string }>("/secrets"),
  createSecret: (input: { name: string; description: string; value: string }) => request<Secret>("/secrets", { method: "POST", body: body(input) }),
  updateSecret: (id: string, input: { description?: string; value?: string }) => request<Secret>(`/secrets/${id}`, { method: "PUT", body: body(input) }),
  deleteSecret: (id: string) => request<{ ok: boolean }>(`/secrets/${id}`, { method: "DELETE" }),
  grantSecret: (id: string, botId: string, granted: boolean) => request<Secret>(`/secrets/${id}/grants/${botId}`, { method: "PUT", body: body({ granted }) }),
  secretUses: (id: string) => request<{ uses: SecretUse[] }>(`/secrets/${id}/uses`),
  /** Answers a request card: the value goes here, never into a message. */
  fulfilSecret: (chatId: string, messageId: string, input: { value?: string; scope: "always" | "once" }) =>
    request<ChatMessage>(`/secrets/requests/${chatId}/${messageId}`, { method: "POST", body: body(input) }),
  botStatus: (id: string) => request<BotStatus>(`/bots/${id}/status`),
  uploadAttachment: upload,
  removeAttachment: (id: string) => request<{ ok: boolean }>(`/attachments/${id}`, { method: "DELETE" }),
  authStatus: (id: string) => request<LoginState>(`/model-connections/${id}/auth`),
  authStart: (id: string) => request<LoginState>(`/model-connections/${id}/auth`, { method: "POST" }),
  authCancel: (id: string) => request<LoginState>(`/model-connections/${id}/auth`, { method: "DELETE" }),
  authInput: (id: string, promptId: string, value: string) => request<LoginState>(`/model-connections/${id}/auth/input`, { method: "POST", body: body({ promptId, value }) }),
  authLogout: (id: string) => request<{ ok: boolean }>(`/model-connections/${id}/auth/logout`, { method: "POST" }),
  modelCatalog: (id: string) => request<{ models: ConfiguredModel[] }>(`/model-connections/${id}/catalog`),
  modelResetPlan: (id: string) => request<ModelResetPlan>(`/model-connections/${id}/reset`),
  resetModelConnection: (id: string) => request<ModelConnection>(`/model-connections/${id}/reset`, { method: "POST" }),
  providerModels: (name: string) => request<{ models: ConfiguredModel[] }>(`/model-providers/${encodeURIComponent(name)}/models`),
  modelProviders: () => request<{ providers: ProviderOption[] }>("/model-providers"),
  autoconfigModel: (input: { modelId: string; api: string; choice?: { provider: string; modelId: string } }) => request<AutoconfigResult>("/model-autoconfig", { method: "POST", body: body(input) }),
  discoverModels: (input: { connectionId?: string; baseUrl: string; api: string; apiKey?: string }) => request<{ models: ConfiguredModel[] }>("/model-discovery", { method: "POST", body: body(input) }),
  modelConnections: () => request<{ connections: ModelConnection[] }>("/model-connections"),
  createModelConnection: (input: { providerName: string; displayName: string; kind: "builtin" | "custom"; authType: "api_key" | "oauth"; baseUrl?: string; api?: string; apiKey?: string }) => request<ModelConnection>("/model-connections", { method: "POST", body: body(input) }),
  updateModelConnection: (id: string, input: { providerName?: string; displayName: string; baseUrl: string; api: string }) => request<ModelConnection>(`/model-connections/${id}`, { method: "PUT", body: body(input) }),
  deleteModelConnection: (id: string) => request<{ ok: boolean }>(`/model-connections/${id}`, { method: "DELETE" }),
  saveModelCredential: (id: string, apiKey?: string, remove = false) => request<ModelConnection>(`/model-connections/${id}/credential`, { method: "PUT", body: body({ apiKey, remove }) }),
  saveConnectionModel: (id: string, model: ModelInput, originalId?: string) => request<ModelConnection>(`/model-connections/${id}/models`, { method: originalId ? "PUT" : "POST", body: body({ model, originalId }) }),
  deleteConnectionModel: (id: string, modelId: string) => request<ModelConnection>(`/model-connections/${id}/models`, { method: "DELETE", body: body({ modelId }) }),
};
