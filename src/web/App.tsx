import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, ApiError } from "./api";
import { type Attachment, type Chat, type ChatMessage, type Member, type Section, type ThreadEntry } from "../contract/chat";
import { type BotStatus, type Bot } from "../contract/bots";
import { type ModelConnection } from "../contract/models";
import { AppDialogs, type Confirm, type Dialog, type Menu } from "./AppDialogs";
import { AppSidebar } from "./AppSidebar";
import { ChatMain } from "./ChatMain";
import { SidePane } from "./SidePane";
import { SettingsDialog, type SettingsTab } from "./Settings";
import { hintThread } from "./sidebar/Sidebar";
import { findMentions } from "./channel/mentions";
import { DraftStore, draftKey, quoteMessage } from "./composer/drafts";
import { useBotDirects } from "./bot/BotDirects";
import { useTabBadge } from "./tabBadge";
import { activityLabel, freeBotName, liveMembers } from "./members";
import { useTranscript } from "./transcript/useTranscript";
import { useMarkRead } from "./transcript/useMarkRead";
import { Login } from "./Login";
import { applyTheme } from "./ui";
import { t } from "./i18n";
import type { InfoPage } from "./channel/ChannelInfo";
import type { Pane } from "./pane";
import { useFind } from "./search/useFind";
import { errorText, statusError } from "./errors";

// Dynamic import makes the annotation tool dev-only; nothing is bundled in production.
const DevAgentation = import.meta.env.DEV
  ? lazy(async () => {
    await import("./styles/agentation-dev.css");
    return { default: (await import("agentation")).Agentation };
  })
  : null;

export function App() {
  const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
  const [username, setUsername] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({});
  const statusVersions = useRef(new Map<string, number>());
  const [chats, setChats] = useState<Chat[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Read position when each chat was opened: the "以下为新消息" line stays there while you read. */
  const [dividers, setDividers] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [focusedBotId, setFocusedBotId] = useState<string | null>(null);
  const [infoBotId, setInfoBotId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [accountMenu, setAccountMenu] = useState(false);
  const [createMenu, setCreateMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [pane, setPane] = useState<Pane | null>(null);
  /** The main area shows 「我关注的线程」 instead of a chat. */
  const [followedView, setFollowedView] = useState(false);
  const [paneWidth, setPaneWidth] = useState(420);
  /** Bumped on every chat change, so open panes and lists reload. */
  const [tick, setTick] = useState(0);
  const [followed, setFollowed] = useState<ThreadEntry[]>([]);
  const [notice, setNotice] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const chatArea = useRef<HTMLElement>(null), composeWrap = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<{ files: Attachment[]; index: number } | null>(null);
  /** The message being replied to, per chat: switching chats keeps a draft reply with its chat. */
  /** The sidebar's 「…」 menu target, and where a right-click opened it. */
  const [entryMenu, setEntryMenu] = useState<Menu>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const chatRequest = useRef(0);
  const chatListRef = useRef(chats); chatListRef.current = chats;
  const paneRef = useRef(pane); paneRef.current = pane;
  /** This account's drafts: each account has its own store and storage key. */
  const drafts = useMemo(() => new DraftStore(draftKey(username)), [username]);
  // Text waits 300 ms before it is saved; leaving the page saves it at once.
  useEffect(() => { const save = () => drafts.save(); window.addEventListener("pagehide", save); return () => window.removeEventListener("pagehide", save); }, [drafts]);
  const meId = members.find(member => member.kind === "user" && member.name === username)?.id ?? "";
  // Newest page first, older pages as you scroll up.
  const history = useTranscript({ chatId: selected, ready: phase === "ready", scroller: transcript, me: meId, onError: handleError });
  const { messages, setMessages } = history;
  const find = useFind({ selected, chats, transcript: history, openChat, setPane, paneRef, blocked: !!infoBotId || !!settingsTab });

  const statusBotId = chats.find(chat => chat.id === selected)?.botId ?? focusedBotId ?? bots[0]?.id;
  async function readStatus(id: string) {
    const version = (statusVersions.current.get(id) ?? 0) + 1; statusVersions.current.set(id, version);
    const status = await api.botStatus(id);
    if (statusVersions.current.get(id) === version) setStatuses(previous => ({ ...previous, [id]: status }));
  }
  useEffect(() => { if (phase === "ready" && statusBotId) void readStatus(statusBotId).catch(handleError); }, [phase, statusBotId]);
  // A channel's member list shows what each of its Bots is doing.
  const channelBots = chats.find(chat => chat.id === selected && chat.type === "channel")?.memberIds.filter(id => bots.some(bot => bot.id === id)).join(",") ?? "";
  useEffect(() => { if (phase === "ready" && channelBots) for (const id of channelBots.split(",")) void readStatus(id).catch(handleError); }, [phase, channelBots]);

  async function loadData(name: string) {
    const [botList, list, catalog, sectionList, memberList, threadList] = await Promise.all([api.bots(), api.chats(), api.modelConnections(), api.sections(), api.members(), api.followedThreads()]);
    setUsername(name); setBots(botList.bots); setChats(list.chats); setConnections(catalog.connections); setSections(sectionList.sections); setMembers(memberList.members);
    setFollowed(threadList.threads);
    const first = list.chats.find(chat => chat.type !== "thread");
    setSelected(first?.id ?? null);
    if (first) setDividers({ [first.id]: first.readSequence });
    setFocusedBotId(list.chats[0]?.botId ?? botList.bots[0]?.id ?? null);
    setPhase("ready");
  }
  useEffect(() => {
    applyTheme(localStorage.getItem("jarvy-theme") === "dark" ? "dark" : "light");
    void api.me().then(user => loadData(user.username)).catch(() => setPhase("login"));
  }, []);
  useEffect(() => {
    if (phase !== "ready") return;
    let alive = true;
    const source = new EventSource("/api/events");
    const refresh = async (chatId?: string) => {
      void api.followedThreads().then(result => { if (alive) setFollowed(result.threads); }).catch(() => {});
      setTick(value => value + 1);
      await refreshChats();
      const id = selectedRef.current;
      if (alive && id && (!chatId || chatId === id)) await refreshTranscript(id);
    };
    // Bots create and rename channel groups too.
    const reloadSections = () => void api.sections().then(result => { if (alive) setSections(result.sections); }).catch(error => { if (alive) handleError(error); });
    source.addEventListener("ready", () => {
      void refresh().catch(error => { if (alive) handleError(error); }); reloadSections();
      const id = chatListRef.current.find(chat => chat.id === selectedRef.current)?.botId;
      if (id) void readStatus(id).catch(error => { if (alive) handleError(error); });
      void api.bots().then(result => { if (alive) setBots(result.bots); }).catch(error => { if (alive) handleError(error); });
    });
    source.addEventListener("sections", reloadSections);
    // The agent Bot created, changed or deleted Bots (A48): reload them, and the chats a deleted one leaves.
    source.addEventListener("bots", () => {
      void api.bots().then(result => { if (alive) setBots(result.bots); }).catch(error => { if (alive) handleError(error); });
      void refresh().catch(error => { if (alive) handleError(error); });
    });
    // Something was delivered to you (A41): the rows' red counts and hints come with the chat list.
    source.addEventListener("inbox", () => void refresh().catch(error => { if (alive) handleError(error); }));
    source.addEventListener("chat", event => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { chatId?: string };
      if (typeof data.chatId === "string") void refresh(data.chatId).catch(error => { if (alive) handleError(error); });
    });
    source.addEventListener("bot", event => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { botId: string; status: BotStatus };
      const status = data.status;
      statusVersions.current.set(data.botId, (statusVersions.current.get(data.botId) ?? 0) + 1);
      setStatuses(previous => ({ ...previous, [data.botId]: status }));
      if (status.error && chatListRef.current.find(chat => chat.id === selectedRef.current)?.botId === status.botId) setNotice(statusError(status));
      if (status.status === "idle" || status.status === "stop") void api.bots().then(result => { if (alive) setBots(result.bots); }).catch(error => { if (alive) handleError(error); });
    });
    source.onerror = () => { void api.me().catch(error => { if (alive && error instanceof ApiError && error.status === 401) setPhase("login"); }); };
    return () => { alive = false; source.close(); history.cancel(); chatRequest.current++; };
  }, [phase]);
  useMarkRead({ ready: phase === "ready", selected, messages, chats, chatList: chatListRef, setChats, onError: handleError });
  useTabBadge(phase === "ready" ? chats.reduce((sum, chat) => sum + chat.alerts, 0) : 0);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4800);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // Radix owns dialog and nested-picker keyboard handling.
      if (event.defaultPrevented || infoBotId || settingsTab) return;
      if (event.key === "Escape") { setAccountMenu(false); setCreateMenu(false); setMobileNav(false); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileNav(window.matchMedia("(max-width: 620px)").matches);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#jarvy-search")?.focus());
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [infoBotId, settingsTab]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 620px)");
    const closeOnDesktop = () => { if (!media.matches) setMobileNav(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { setPhase("login"); return; }
    setNotice(errorText(error, "common.failed"));
  }
  async function refreshChats() {
    const request = ++chatRequest.current;
    const result = await api.chats(); if (request === chatRequest.current) setChats(result.chats);
    return result.chats;
  }
  async function refreshTranscript(id: string) { await history.refresh(id); }
  async function refreshConnections() {
    const [catalog, botList] = await Promise.all([api.modelConnections(), api.bots()]);
    setConnections(catalog.connections); setBots(botList.bots);
  }
  const refreshMembers = () => void api.members().then(result => setMembers(result.members)).catch(handleError);
  function updateBot(updated: Bot) { setBots(previous => previous.map(item => item.id === updated.id ? updated : item)); refreshMembers(); }
  /** Opens a chat; its read position at this moment marks where "以下为新消息" goes. */
  function openChat(chat: Chat) {
    // A channel row hinting at a thread (「X 更新了线程「…」的摘要」) opens that thread too, so the lead is not lost.
    const thread = hintThread(chat);
    if (thread) setPane({ kind: "thread", id: thread, parentId: chat.id, mode: "pane", summary: chat.hint?.kind === "note" });
    else if (chat.id !== selectedRef.current) setPane(null);
    setFollowedView(false);
    setDividers(previous => ({ ...previous, [chat.id]: chat.readSequence }));
    setSelected(chat.id); if (chat.botId) setFocusedBotId(chat.botId);
    setMobileNav(false); setAccountMenu(false); setCreateMenu(false);
  }
  /** The header's name and members button open channel info at its main or member page; again closes it. */
  const toggleInfo = (page: InfoPage) => setPane(pane?.kind === "info" && pane.page === page ? null : { kind: "info", page });
  function chatSaved(chat: Chat) {
    setChats(previous => previous.some(item => item.id === chat.id) ? previous.map(item => item.id === chat.id ? chat : item) : [chat, ...previous]);
  }
  /** Opens the Bot's DM; the server returns the existing one or creates it (one DM per pair). */
  async function openBot(botId: string) {
    if (creating) return;
    setCreating(true);
    try {
      const chat = await api.createChat(botId);
      chatSaved(chat); openChat(chat);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#jarvy-composer")?.focus());
    } catch (error) { handleError(error); }
    finally { setCreating(false); }
  }
  async function createBot() {
    if (creating) return;
    setCreating(true);
    try {
      const bot = await api.createBot(freeBotName(liveMembers(members).map(member => member.name)));
      const chat = await api.createChat(bot.id);
      setBots(previous => [...previous, bot]); chatSaved(chat); refreshMembers(); openChat(chat);
    } catch (error) { handleError(error); }
    finally { setCreating(false); }
  }
  async function removeChannel(chat: Chat) {
    try {
      await api.deleteChat(chat.id);
      await refreshChats();
      if (selectedRef.current === chat.id) setSelected(null);
      setNotice(t("app.channelDeleted"));
    } catch (error) { handleError(error); }
  }
  /** Pin or unpin a chat in its sidebar group. */
  async function pinChat(chat: Chat, pinned: boolean) {
    try { chatSaved(await api.pin(chat.id, pinned)); }
    catch (error) { handleError(error); }
  }
  async function muteChat(chat: Chat, muted: boolean) {
    try { chatSaved(await api.mute(chat.id, muted)); }
    catch (error) { handleError(error); }
  }
  /** Delete a Bot: its DMs and memberships go, its messages stay. */
  async function deleteBot(bot: Bot, deleteFiles: boolean) {
    try {
      await api.deleteBot(bot.id, deleteFiles);
      const gone = new Set(chats.filter(chat => chat.type === "dm" && chat.botId === bot.id).map(chat => chat.id));
      setChats(previous => previous.filter(chat => !gone.has(chat.id)).map(chat => chat.memberIds.includes(bot.id) ? { ...chat, memberIds: chat.memberIds.filter(id => id !== bot.id) } : chat));
      setBots(previous => previous.filter(item => item.id !== bot.id));
      refreshMembers();
      if (selectedRef.current && gone.has(selectedRef.current)) setSelected(null);
      if (infoBotId === bot.id) setInfoBotId(null);
      setNotice(t("app.botDeleted", { name: bot.name }));
    } catch (error) { handleError(error); }
  }
  async function sendMain(content: string, attachmentIds: string[], key: string, replyTo?: string, quotes?: { messageId: string; text: string }[]) {
    const id = selected!;
    await api.send(id, content, attachmentIds, key, false, replyTo, quotes);
    const chat = chatListRef.current.find(item => item.id === id), outside = chat?.type === "channel"
      ? [...new Set(findMentions(content, liveMembers(members)).filter(hit => !chat.memberIds.includes(hit.member.id)).map(hit => hit.member.name))] : [];
    if (outside.length) setNotice(t("app.notInChannel", { names: outside.join(t("common.listSeparator")), count: outside.length }));
    // Sent once the server has it: catching up the transcript and the list must not hold the composer or undo the send.
    void Promise.all([refreshTranscript(id), refreshChats()]).catch(handleError);
  }
  /** Adds someone picked from the @ menu to the channel (or the thread's channel). */
  function invite(channelId: string, member: Member) {
    void api.addMember(channelId, member.id).then(chat => { chatSaved(chat); setNotice(t("app.memberAdded", { name: member.name, channel: chat.title })); }).catch(handleError);
  }
  async function replyInThread(message: ChatMessage) {
    try { const thread = await api.openThread(message.id); setPane({ kind: "thread", id: thread.id, parentId: message.chatId, mode: "pane" }); }
    catch (error) { handleError(error); }
  }
  /** Back from a full-width thread to its channel, optionally keeping the thread beside it. */
  function toChannel(thread: { id: string; parentId: string }, keepPane: boolean) {
    const channel = chats.find(chat => chat.id === thread.parentId);
    if (channel) openChat(channel);
    setPane(keepPane ? { kind: "thread", id: thread.id, parentId: thread.parentId, mode: "pane" } : null);
  }
  /** Opens a channel, or a thread beside its channel (from a Bot's subscriptions). */
  function openAnywhere(chat: Chat) {
    setInfoBotId(null);
    const channel = chats.find(item => item.id === (chat.type === "thread" ? chat.parentId : chat.id));
    if (channel) openChat(channel);
    if (chat.type === "thread") setPane({ kind: "thread", id: chat.id, parentId: chat.parentId!, mode: "pane" });
  }
  /** Adds or removes an emoji mark; the server answers with the message's current marks. */
  async function react(message: ChatMessage, emoji: string, on: boolean) {
    try {
      const updated = await api.react(message.id, emoji, on);
      setMessages(previous => previous.map(item => item.id === updated.id ? { ...item, reactions: updated.reactions } : item));
    } catch (error) { handleError(error); }
  }
  async function fold(message: ChatMessage, folded: boolean) {
    try {
      const updated = await api.fold(message.id, folded);
      setMessages(previous => previous.map(item => item.id === updated.id ? { ...item, folded: updated.folded } : item));
    } catch (error) { handleError(error); }
  }
  /** The composer's quote bar: part of the quoted message's chat draft. */
  function setReplyFor(message: ChatMessage) { quoteMessage(drafts, message, members); }
  /** A reply's or a partial quote's source (A44): scrolls to it and highlights the passage; null means it is gone. */
  /** A quote tag (or a reply bar): its message here, or — in a channel copy of a thread reply — in that thread (A44). */
  const jumpTo = (id: string | null, passage?: string) => id ? void history.toMessage(id, passage)
    .then(async elsewhere => { if (elsewhere) find.openMessage(await api.chat(elsewhere), id, passage); }).catch(() => setNotice(t("app.sourceGone"))) : setNotice(t("app.sourceGone"));
  function threadChanged(thread: Chat) {
    setFollowed(previous => previous.map(item => item.id === thread.id ? { ...item, ...thread } : item));
    void api.followedThreads().then(result => setFollowed(result.threads)).catch(() => {});
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const move = (moved: globalThis.PointerEvent) => setPaneWidth(Math.min(Math.max(340, window.innerWidth - moved.clientX), Math.round(window.innerWidth * 0.6)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); document.body.style.cursor = "col-resize";
  }
  async function logOut() {
    try {
      await drafts.clear(id => api.removeAttachment(id));
      await api.logout(); setPhase("login"); setAccountMenu(false); setSettingsTab(null);
      statusVersions.current.clear(); setStatuses({}); setPane(null); setFollowed([]);
      setUsername(""); setSelected(null); setChats([]); setBots([]); setConnections([]); setMessages([]);
    } catch (error) { handleError(error); }
  }
  // The transcript shrinks when the composer grows (more lines, file chips) or the viewport does;
  // keep its bottom edge anchored so the newest messages stay in view instead of sliding under it.
  const hasTranscript = phase === "ready" && chats.some(chat => chat.id === selected);
  useEffect(() => {
    const el = transcript.current;
    if (!el) return;
    // Distance from the bottom, kept current by scrolling and by content changes. Re-applied after a
    // resize rather than adding the size delta, because growing at the bottom already clamps scrollTop.
    let gap = 0, height = el.clientHeight;
    const remember = () => { gap = el.scrollHeight - el.scrollTop - el.clientHeight; };
    const resized = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      el.scrollTo({ top: el.scrollHeight - el.clientHeight - gap, behavior: "instant" });
    });
    const changed = new MutationObserver(remember);
    remember();
    el.addEventListener("scroll", remember, { passive: true });
    resized.observe(el); changed.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { resized.disconnect(); changed.disconnect(); el.removeEventListener("scroll", remember); };
  }, [hasTranscript]);
  const viewing = chats.find(chat => chat.id === selected), inChannel = viewing?.type === "channel";
  const botDirects = useBotDirects(phase === "ready" ? chats.find(chat => chat.id === selected && chat.type === "dm")?.botId ?? undefined : undefined, tick);
  if (phase === "loading") return <div className="jarvy-loading">{t("app.connecting")}</div>;
  if (phase === "login") return <Login onLogin={name => void loadData(name).catch(handleError)}/>;
  const current = chats.find(chat => chat.id === selected);
  const activeBot = bots.find(bot => bot.id === (current?.botId ?? focusedBotId)) ?? bots[0];
  const activeBotReady = !!activeBot?.connectionId;
  // A channel takes messages whether or not its Bots have models; a DM needs its Bot's model first.
  const composeReady = inChannel || activeBotReady;
  const botName = activeBot?.name ?? "Jarvy";
  const status = activeBot ? statuses[activeBot.id] : undefined;
  const activity = status?.error ? t("activity.error") : status?.status === "running" ? activityLabel(status.activity) : "";
  // Only the latest question still waiting for an answer takes the A–F shortcuts.
  const activeQuestion = [...messages].reverse().find(message => message.question?.state === "pending")?.id;
  const openThread = pane?.kind === "thread" ? pane : null, full = openThread?.mode === "full";
  const paneChannel = inChannel ? viewing : undefined;
  const infoBot = bots.find(bot => bot.id === infoBotId);
  const working = new Set(Object.values(statuses).filter(item => item.status === "running" && item.activity !== "asking").map(item => item.botId));
  const asking = new Set(Object.values(statuses).filter(item => item.activity === "asking").map(item => item.botId));
  return <>
    <div className="ui-app" data-nav={mobileNav ? "" : undefined} data-pane={pane && !full ? "" : undefined} style={{ ["--ui-pane" as string]: `${paneWidth}px` }}>
      <AppSidebar username={username} chats={chats} sections={sections} bots={bots} members={members} followed={followed} followedOpen={followedView && !full}
        working={working} asking={asking} selected={followedView ? null : selected} filter={filter} creating={creating} createMenu={createMenu} accountMenu={accountMenu}
        onFilterChange={setFilter}
        onOpenFollowed={() => { setFollowedView(true); setPane(null); setMobileNav(false); }} onOpenChat={openChat} onOpenBot={bot => void openBot(bot.id)}
        onOpenMenu={(target, at) => setEntryMenu({ target, at })} onEditSection={section => setDialog({ kind: "section", section })}
        onCreate={what => { if (what === "bot") return void createBot(); setDialog({ kind: what }); setCreateMenu(false); }}
        onFind={find.openMessage} onOpenFound={openAnywhere} onError={handleError}
        onToggleCreate={open => { setCreateMenu(open); setAccountMenu(false); }} onToggleAccount={open => { setAccountMenu(open); setCreateMenu(false); }}
        onSettings={() => { setAccountMenu(false); setSettingsTab("general"); }}
        onToggleTheme={() => { applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"); setAccountMenu(false); }}
        onLogOut={() => void logOut()}/>
      <ChatMain chat={current} inChannel={inChannel} bots={bots} members={members} meId={meId} drafts={drafts} composeReady={composeReady} botName={botName}
        activeBot={activeBot} status={status} connections={connections} activity={activity} history={history} divider={dividers[current?.id ?? ""] ?? current?.readSequence ?? 0} activeQuestion={activeQuestion}
        pane={pane} onPane={setPane} onToggleInfo={toggleInfo} find={find} onNav={() => setMobileNav(true)} onBot={id => setInfoBotId(id)} hasBotDirects={botDirects.length > 0}
        onInvite={invite} onQuote={setReplyFor} onReply={message => void replyInThread(message)} onReact={(message, emoji, on) => void react(message, emoji, on)} onFold={(message, folded) => void fold(message, folded)}
        onJump={jumpTo} onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))}
        onPreview={(files, index) => setPreview({ files, index })} onSend={sendMain} notice={setNotice}
        onSaveNote={async text => { try { chatSaved(await api.setNote(current!.id, text)); } catch (error) { handleError(error); throw error; } }}
        createBot={() => void createBot()} creating={creating} updateBot={updateBot} onManageModels={() => setSettingsTab("models")} error={handleError}
        chatArea={chatArea} transcript={transcript} composeWrap={composeWrap} hidden={full || followedView}
        onOpenThread={id => setPane({ kind: "thread", id, parentId: current!.id, mode: "pane" })}/>
      <SidePane pane={pane} followedView={followedView} followed={followed} chats={chats} sections={sections} members={members} bots={bots} statuses={statuses}
        meId={meId} drafts={drafts} tick={tick} paneChannel={paneChannel} activeBot={activeBot} botDirects={botDirects} find={find}
        onPane={setPane} onNav={() => setMobileNav(true)} onBackToChannel={toChannel} onAddMembers={chat => setDialog({ kind: "members", chat })} onOpenBot={setInfoBotId}
        onPin={chat => void pinChat(chat, !chat.pinned)} onMute={chat => void muteChat(chat, !chat.muted)} onDeleteChannel={chat => setConfirm({ kind: "chat", chat })}
        onChannelSaved={chatSaved} onThreadChanged={threadChanged} onInvite={invite} onPreview={(files, index) => setPreview({ files, index })}
        onNotice={setNotice} onError={handleError} paneWidth={paneWidth} onResize={startResize}/>
    </div>
    {mobileNav && <div className="ui-nav-scrim" onClick={() => setMobileNav(false)} role="presentation"/>}
    {settingsTab && <SettingsDialog connections={connections} initialTab={settingsTab} onChanged={refreshConnections} onClose={() => setSettingsTab(null)}/>}
    <AppDialogs dialog={dialog} entryMenu={entryMenu} confirm={confirm} preview={preview} infoBot={infoBot} bots={bots} statuses={statuses} chats={chats}
      sections={sections} members={members} connections={connections} meId={meId}
      onDialog={setDialog} onEntryMenu={setEntryMenu} onConfirm={setConfirm} onPreview={setPreview} onInfoBot={setInfoBotId} onSettings={() => setSettingsTab("models")}
      onChannelInfo={chat => { openChat(chat); setPane({ kind: "info", page: "main" }); }}
      onOpenChatId={id => { setSelected(id); setMobileNav(false); }}
      chatSaved={chatSaved} openChat={openChat}
      onSectionSaved={section => { setSections(previous => previous.some(item => item.id === section.id) ? previous.map(item => item.id === section.id ? section : item) : [...previous, section]); setDialog(null); }}
      onSectionDeleted={id => { setDialog(null); setSections(previous => previous.filter(item => item.id !== id)); void refreshChats().catch(handleError); }}
      updateBot={updateBot} openAnywhere={openAnywhere} removeChannel={removeChannel} deleteBot={deleteBot} pinChat={pinChat} muteChat={muteChat}/>
    {notice && <div className="ui-toast" role="status">{notice}</div>}
    {DevAgentation && <Suspense fallback={null}><DevAgentation appName="Jarvy" className="jarvy-dev-annotation" enableKeyboardShortcuts={false}/></Suspense>}
  </>;
}
