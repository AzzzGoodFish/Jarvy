import type { BotColor, BotMood } from "./avatar/palette";
import { t } from "./i18n";
export interface ProviderOption { id: string; name: string; authType: "oauth" | "api_key"; api: string; modelCount: number; }
export interface BotStatus { botId: string; status: "stop" | "idle" | "running"; activity: "reasoning" | "texting" | "tool_calling" | "asking" | null; phase: string; runId?: string | null; error: string | null; errorCode: string | null; errorParams?: Record<string, string | number>; context?: { tokens: number | null; contextWindow: number; percent: number | null }; }
export interface CredentialState {
  phase: "idle" | "running" | "completed" | "cancelled" | "error";
  prompt?: { id: string; type: "select" | "text" | "secret" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
  event?: { type: "auth_url"; url: string; instructions?: string } | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number } | { type: "info"; message: string; links?: { url: string; label?: string }[] } | { type: "progress"; message: string };
}
export interface Bot { id: string; name: string; description: string; systemPrompt: string; connectionId: string | null; modelId: string; thinkingLevel: string; effectiveThinkingLevel: string | null; workspacePath: string; color: BotColor; mood: BotMood; createdAt: number; }
export interface ConfiguredModel { api?: string; headerNames?: string[]; headerUpdates?: Record<string, string | null>; id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; contextWindow: number | null; maxTokens: number | null; thinkingFormat: string; thinkingLevelMap: Record<string, string | null>; compat: Record<string, unknown>; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; }
export interface AutoconfigSource { provider: string; modelId: string; name: string; api: string; official: boolean; }
export type AutoconfigFields = Pick<ConfiguredModel, "reasoning" | "input" | "contextWindow" | "maxTokens" | "cost" | "thinkingLevelMap" | "thinkingFormat" | "compat">;
export type AutoconfigResult =
  | { status: "matched"; source: AutoconfigSource; reseller: boolean; apiMismatch: boolean; fields: AutoconfigFields; alternatives: AutoconfigSource[] }
  | { status: "choose"; reason: "multiple" | "similar"; options: AutoconfigSource[] }
  | { status: "none" };
export interface ModelConnection { id: string; providerName: string; displayName: string; kind: "builtin" | "custom"; baseUrl: string; api: string; authType: "api_key" | "oauth"; configured: boolean; models: ConfiguredModel[]; createdAt: number; updatedAt: number; }
export interface Member { id: string; name: string; kind: "user" | "bot"; /** A deleted Bot: still shown as the author of old messages. */ deleted?: boolean; }
/** A project grouping channels (A37). */
export interface Section { id: string; name: string; position: number; createdAt: number; updatedAt: number; }
/** `chatId` / `title`: where it happened — the chat itself, or for a channel row one of its threads. */
export interface ChatHint { kind: "reaction" | "note"; chatId: string; chatType: string; title: string; actor: string; detail: string; createdAt: number; }
export interface ChatNote { text: string; updatedBy: Member; updatedAt: number; version: number; }
/** botId is the DM's Bot (null for channels); unread/mentions/readSequence are for you. */
export interface Chat { id: string; type: "dm" | "channel" | "thread"; botId: string; title: string; createdAt: number; updatedAt: number; lastMessage: Pick<ChatMessage, "content" | "quotes"> | null;
  memberIds: string[]; sectionId: string | null; topic: string; parentId: string | null; rootMessageId: string | null; status: "open" | "done" | null;
  note: ChatNote | null; readSequence: number; unread: number; mentions: number;
  /** Delivered to you with an interrupt and not read (DMs, @, replies): the red count (A41). */
  alerts: number;
  /** The newest queued delivery you have not seen (a mark on your message, a new notice / summary): the hint line. */
  hint: ChatHint | null;
  /** Some unread messages delivered to you @ you or reply to you (the 「[有人@我]」 mark). */
  atMe: boolean;
  /** You muted it (免打扰): only @ and replies still show red. */
  muted: boolean;
  /** Who wrote the last message (channel rows: 「名字：消息」). */
  lastSender: string | null;
  /** Threads only: you follow it (only followed threads count as unread). */
  following: boolean;
  /** Channels and threads: you subscribed to it (every new message is delivered to you). */
  subscribed: boolean;
  /** You pinned it to the top of its sidebar group. */
  pinned: boolean; }
/** A thread as listed (channel thread list, 「我关注的线程」). */
export interface ThreadEntry extends Chat { replies: number; lastReplyAt: number | null; root: { senderId: string; content: string; quotes: MessageQuote[] } | null; }
export interface ThreadInfo { id: string; title: string; status: "open" | "done"; replies: number; lastReplyAt: number | null; }
export interface Attachment { id: string; name: string; mimeType: string; size: number; }
export interface QuestionOption { label: string; value?: string; description?: string; style?: "default" | "primary" | "danger"; }
/** A Bot's question card (messages.ask, A36); pending while the Bot's tool call waits. */
export interface Question { question: string; detail?: string; options: QuestionOption[]; multiple: boolean; allowCustom: boolean;
  state: "pending" | "answered" | "dismissed" | "ignored"; answer: { selected: number[]; custom: string | null } | null; settledAt: number | null; }
export interface Reaction { emoji: string; memberIds: string[]; }
/** What the search box found: chats only when searching everywhere. */
export interface SearchResult { chats: Chat[]; messages: { message: ChatMessage; chat: Chat }[] }
export interface ChatMessage { id: string; chatId: string; sequence: number; senderId: string; source: { historyId: number; toolCallId: string } | null; role: "user" | "assistant"; content: string; createdAt: number; attachments: Attachment[]; question: Question | null; mentions: string[];
  /** The message this one replies to (same chat), with the start of its text. */
  replyTo: { id: string; senderId: string; content: string; quotes: MessageQuote[] } | null;
  /** Emoji marks, grouped, in the order each emoji was first used. */
  reactions: Reaction[];
  /** Channel messages: the thread under it. */
  thread: ThreadInfo | null;
  /** A channel copy of a thread reply, or a thread's conclusion. */
  echoOf: { id: string; title: string } | null;
  /** Partial quotes (A44), in the order of the [[q1]] … [[qN]] markers in content; messageId is null once the source is gone. */
  quotes: MessageQuote[]; }
export interface MessageQuote { messageId: string | null; senderId: string; text: string; }
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
 * `onProgress` how much of the file has gone out (0–1). */
function upload(chatId: string, file: File, onProgress?: (done: number) => void) {
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
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
  selectBotModel: (id: string, connectionId: string, modelId: string, thinkingLevel: string) => request<Bot>(`/bots/${id}/model`, { method: "PUT", body: body({ connectionId, modelId, thinkingLevel }) }),
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
  botSubscriptions: (botId: string) => request<{ chats: Chat[] }>(`/members/${botId}/subscriptions`),
  controlBot: (id: string, action: "start" | "stop" | "abort") => request<BotStatus>(`/bots/${id}/${action}`, { method: "POST" }),
  botStatus: (id: string) => request<BotStatus>(`/bots/${id}/status`),
  uploadAttachment: upload,
  removeAttachment: (id: string) => request<{ ok: boolean }>(`/attachments/${id}`, { method: "DELETE" }),
  authStatus: (id: string) => request<CredentialState>(`/model-connections/${id}/auth`),
  authStart: (id: string) => request<CredentialState>(`/model-connections/${id}/auth`, { method: "POST" }),
  authCancel: (id: string) => request<CredentialState>(`/model-connections/${id}/auth`, { method: "DELETE" }),
  authInput: (id: string, promptId: string, value: string) => request<CredentialState>(`/model-connections/${id}/auth/input`, { method: "POST", body: body({ promptId, value }) }),
  authLogout: (id: string) => request<{ ok: boolean }>(`/model-connections/${id}/auth/logout`, { method: "POST" }),
  modelCatalog: (id: string) => request<{ models: ConfiguredModel[] }>(`/model-connections/${id}/catalog`),
  providerModels: (name: string) => request<{ models: ConfiguredModel[] }>(`/model-providers/${encodeURIComponent(name)}/models`),
  modelProviders: () => request<{ providers: ProviderOption[] }>("/model-providers"),
  autoconfigModel: (input: { modelId: string; api: string; choice?: { provider: string; modelId: string } }) => request<AutoconfigResult>("/model-autoconfig", { method: "POST", body: body(input) }),
  discoverModels: (input: { connectionId?: string; baseUrl: string; api: string; apiKey?: string }) => request<{ models: ConfiguredModel[] }>("/model-discovery", { method: "POST", body: body(input) }),
  modelConnections: () => request<{ connections: ModelConnection[] }>("/model-connections"),
  createModelConnection: (input: { providerName: string; displayName: string; kind: "builtin" | "custom"; authType: "api_key" | "oauth"; baseUrl?: string; api?: string; apiKey?: string }) => request<ModelConnection>("/model-connections", { method: "POST", body: body(input) }),
  updateModelConnection: (id: string, input: { providerName?: string; displayName: string; baseUrl: string; api: string }) => request<ModelConnection>(`/model-connections/${id}`, { method: "PUT", body: body(input) }),
  deleteModelConnection: (id: string) => request<{ ok: boolean }>(`/model-connections/${id}`, { method: "DELETE" }),
  saveModelCredential: (id: string, apiKey?: string, remove = false) => request<ModelConnection>(`/model-connections/${id}/credential`, { method: "PUT", body: body({ apiKey, remove }) }),
  saveConnectionModel: (id: string, model: ConfiguredModel, originalId?: string) => request<ModelConnection>(`/model-connections/${id}/models`, { method: originalId ? "PUT" : "POST", body: body({ model, originalId }) }),
  deleteConnectionModel: (id: string, modelId: string) => request<ModelConnection>(`/model-connections/${id}/models`, { method: "DELETE", body: body({ modelId }) }),
};

export interface BotModelGroup { id: string; name: string; models: { id: string; name: string; thinking: { levels: string[] }; thinkingLevelMap: Record<string, string | null> }[]; }
