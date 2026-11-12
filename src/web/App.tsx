import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, ApiError } from "./api";
import { type Attachment, type Chat, type ChatMessage, type Member, type Section } from "../contract/chat";
import type { FollowedSummary } from "../contract/threads";
import { type BotStatus, type Bot } from "../contract/bots";
import { type ModelConnection } from "../contract/models";
import { AppDialogs, type Confirm, type Dialog, type Menu } from "./AppDialogs";
import { AppSidebar } from "./AppSidebar";
import { ChatMain } from "./ChatMain";
import { BotCard } from "./bot/BotCard";
import { SidePane } from "./SidePane";
import { ThreadEvents } from "./thread/followed";
import { SettingsDialog, type SettingsTab } from "./Settings";
import { hintThread } from "./sidebar/Sidebar";
import { findMentions } from "../contract/mentions";
import { DraftStore, draftKey, quoteMessage } from "./composer/drafts";
import { useBotDirects } from "./bot/BotDirects";
import { useTabBadge } from "./tabBadge";
import { activityLabel, freeBotName, liveMembers } from "./members";
import { useTranscript } from "./transcript/useTranscript";
import { readUpTo, useMarkRead } from "./transcript/useMarkRead";
import { Rail, type View } from "./home/Rail";
import { Home } from "./home/Home";
import { useAgentFigure } from "./home/figure";
import { useCall } from "./home/call";
import { Environments } from "./environment/Environments";
import { motionOf } from "./avatar/FloatingBot";
import { Login } from "./Login";
import { applyTheme } from "./ui";
import { t } from "./i18n";
import type { InfoPage } from "./channel/ChannelInfo";
import type { Pane } from "./pane";
import { useFind } from "./search/useFind";
import { errorText, statusError } from "./errors";
import { liveEvents } from "./live-events";
import { coalesce } from "./coalesce";
import { chatChanged, noChanges, reconnected, unlistedKey } from "./chat-changes";
import { LiveHub } from "./live";
import { ChatMemory } from "./chat-memory";
import type { LiveBot, LiveChat, LiveMessage, LiveReady, LiveRemoved } from "../contract/events";

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
  // A Bot's profile card, opened from its avatar in a chat (A92), where it opened.
  const [botCard, setBotCard] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** A press on an avatar opens that Bot's card, and a second press on the same one closes it. */
  const openBotCard = (bot: Bot, anchor: DOMRect) => setBotCard(current => current?.id === bot.id ? null : { id: bot.id, anchor });
  const closeBotCard = () => setBotCard(null);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [accountMenu, setAccountMenu] = useState(false);
  const [createMenu, setCreateMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [pane, setPane] = useState<Pane | null>(null);
  /** The agent Bot's page or the chats (A87), remembered in this browser. */
  const [view, setView] = useState<View>(() => { const kept = localStorage.getItem("jarvy-view"); return kept === "home" || kept === "envs" ? kept : "chats"; });
  /** The Environments page's form to add a machine is open (A89). */
  const [addingMachine, setAddingMachine] = useState(false);
  useEffect(() => { localStorage.setItem("jarvy-view", view); }, [view]);
  /** The main area shows 「我关注的线程」 instead of a chat. */
  const [followedView, setFollowedView] = useState(false);
  const [paneWidth, setPaneWidth] = useState(420);
  /** Each chat's changes (A71): an open pane reloads when its own chat changed, not on every change anywhere. */
  const [changes, setChanges] = useState(noChanges);
  /** The followed threads in numbers, with the chat list (A69); the page loads its rows itself and hears of changes here. */
  const [followed, setFollowed] = useState<FollowedSummary | null>(null);
  const [threadEvents] = useState(() => new ThreadEvents());
  /** Changes heard of (A72), for the open panes to put in place; and the chats and threads opened last, as they were
   * left, kept current by the same changes (A79). */
  const [live] = useState(() => new LiveHub()), [memory] = useState(() => new ChatMemory());
  useEffect(() => live.on(heard => memory.heard(heard)), [live, memory]);
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
  const meRef = useRef(meId); meRef.current = meId;
  // Newest page first, older pages as you scroll up.
  const history = useTranscript({ chatId: selected, ready: phase === "ready", scroller: transcript, me: meId, memory, onError: handleError });
  const { messages, setMessages } = history;
  const find = useFind({ selected, chats, transcript: history, openChat, setPane, paneRef, blocked: !!infoBotId || !!settingsTab });

  const statusBotId = chats.find(chat => chat.id === selected)?.botId ?? focusedBotId ?? bots[0]?.id;
  async function readStatus(id: string) {
    const version = (statusVersions.current.get(id) ?? 0) + 1; statusVersions.current.set(id, version);
    const status = await api.botStatus(id);
    if (statusVersions.current.get(id) === version) setStatuses(previous => ({ ...previous, [id]: status }));
  }
  useEffect(() => { if (phase === "ready" && statusBotId) void readStatus(statusBotId).catch(handleError); }, [phase, statusBotId]);
  const agent = bots.find(bot => bot.agent), agentStatus = agent ? statuses[agent.id] : undefined;
  const agentDm = chats.find(chat => chat.type === "dm" && chat.botId === agent?.id), home = view === "home" && !!agent, envs = view === "envs";
  // The chats aren't on screen: the agent Bot's page or the environments cover them.
  const away = home || envs, awayRef = useRef(away); awayRef.current = away;
  const agentCall = useCall(agentStatus, agentDm), agentFigure = useAgentFigure(agent, agentStatus, agentCall.call === "error");
  // The rail's cat and the home page show what the agent Bot is doing, whatever is open.
  useEffect(() => { if (phase === "ready" && agent) void readStatus(agent.id).catch(handleError); }, [phase, agent?.id]);
  // A channel's member list shows what each of its Bots is doing.
  const channelBots = chats.find(chat => chat.id === selected && chat.type === "channel")?.memberIds.filter(id => bots.some(bot => bot.id === id)).join(",") ?? "";
  useEffect(() => { if (phase === "ready" && channelBots) for (const id of channelBots.split(",")) void readStatus(id).catch(handleError); }, [phase, channelBots]);

  async function loadData(name: string) {
    const [botList, list, catalog, sectionList, memberList] = await Promise.all([api.bots(), api.chats(), api.modelConnections(), api.sections(), api.members()]);
    setUsername(name); setBots(botList.bots); setChats(list.chats); setConnections(catalog.connections); setSections(sectionList.sections); setMembers(memberList.members);
    setFollowed(list.followed);
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
    const fail = (error: unknown) => { if (alive) handleError(error); };
    const refreshOpen = async () => { const id = selectedRef.current; if (alive && id) await history.refresh(id); };
    // Bots create and rename channel groups too.
    const reloadSections = () => void api.sections().then(result => { if (alive) setSections(result.sections); }).catch(error => { if (alive) handleError(error); });
    /** A change heard of (A72): its rows into the chat list, the followed numbers, and the change itself to the open
     * transcript and panes. Your DMs and channels are rows of the chat list; a thread or a Bot's DM with another Bot is not. */
    const heard = ({ chat, parent, followed: numbers, message }: LiveChat & { message?: ChatMessage }, kind?: "message" | "updated") => {
      const mine = (row: Chat) => row.type !== "thread" && row.memberIds.includes(meRef.current);
      for (const row of parent ? [chat, parent] : [chat]) if (mine(row)) chatSaved(row);
      if (numbers) setFollowed(numbers);
      // 「我关注的线程」, if open, fetches the thread's row again (A69).
      if (chat.type === "thread") threadEvents.emit({ kind: "changed", id: chat.id });
      // A channel's thread list and a Bot's DMs with other Bots still read again what changed (A71).
      setChanges(changes => chatChanged(changes, chat.id, chat.type === "dm" && !mine(chat)));
      if (message && kind) { history.heard(message, kind === "message"); live.emit({ kind, message }); }
      else live.emit({ kind: "chat", chat });
    };
    const stop = liveEvents("/api/events", {
      // A connection that could not be told what it missed (the first one, or after a restart or a long break): read
      // again what the page shows, every Bot's status too.
      ready: event => {
        if ((JSON.parse(event.data) as LiveReady).resumed) return;
        // What was remembered can't be vouched for: chats are read again when opened, and the open panes (a thread, a
        // Bot's DM with another Bot) now.
        memory.clear(); live.emit({ kind: "reconnected" });
        setChanges(reconnected); void refreshChats().catch(fail); void refreshOpen().catch(fail); reloadSections();
        // 「我关注的线程」, if open, reads its first page again: what changed while the connection was down.
        threadEvents.emit({ kind: "reconnected" });
        void api.bots().then(result => {
          if (!alive) return;
          setBots(result.bots);
          for (const bot of result.bots) void readStatus(bot.id).catch(error => { if (alive) handleError(error); });
        }).catch(error => { if (alive) handleError(error); });
      },
      sections: reloadSections,
      // The agent Bot created, changed or deleted Bots (A48): reload them, and the chats a deleted one leaves.
      bots: () => {
        void api.bots().then(result => { if (alive) setBots(result.bots); }).catch(fail);
        void refreshChats().catch(fail);
      },
      message: event => heard(JSON.parse(event.data) as LiveMessage, "message"),
      "message.updated": event => heard(JSON.parse(event.data) as LiveMessage, "updated"),
      chat: event => heard(JSON.parse(event.data) as LiveChat),
      // A channel deleted (by you elsewhere, or by the agent Bot): its row, and whatever of it is open, go.
      "chat.removed": event => {
        const { chatId, followed: numbers } = JSON.parse(event.data) as LiveRemoved;
        setChats(previous => previous.filter(chat => chat.id !== chatId)); setFollowed(numbers); memory.removed(chatId);
        if (selectedRef.current === chatId) setSelected(null);
        if (paneRef.current?.kind === "thread" && paneRef.current.parentId === chatId) setPane(null);
        // 「我关注的线程」, if open, reads its first page again without its threads.
        threadEvents.emit({ kind: "reconnected" });
      },
      bot: event => {
        const { botId, status, bot } = JSON.parse(event.data) as LiveBot;
        statusVersions.current.set(botId, (statusVersions.current.get(botId) ?? 0) + 1);
        setStatuses(previous => ({ ...previous, [botId]: status }));
        // Said for the open DM's Bot when the chats are on screen; on the home page the agent Bot's own figure says it (A87).
        if (status.error && !awayRef.current && chatListRef.current.find(chat => chat.id === selectedRef.current)?.botId === status.botId) setNotice(statusError(status));
        // Done with a turn, it comes with itself: it may have changed its name, model or computer meanwhile.
        if (bot) setBots(previous => previous.map(item => item.id === bot.id ? bot : item));
      },
    }, () => { void api.me().catch(error => { if (alive && error instanceof ApiError && error.status === 401) setPhase("login"); }); });
    return () => { alive = false; stop(); history.cancel(); chatRequest.current++; };
  }, [phase]);
  // Only an open chat that is on screen is read: not while the home page or the environments cover it.
  useMarkRead({ ready: phase === "ready" && !away, selected, messages, chats, chatList: chatListRef, setChats, onError: handleError });
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
        event.preventDefault(); setView("chats");
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
  // One /chats for a burst of changes (A71): a Bot's message alone brings two or three.
  const [refreshChats] = useState(() => coalesce(async () => {
    const request = ++chatRequest.current;
    const result = await api.chats(); if (request === chatRequest.current) { setChats(result.chats); setFollowed(result.followed); }
    return result.chats;
  }, 100));
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
    setFollowedView(false); setView("chats");
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
    const sent = await api.send(id, content, attachmentIds, key, false, replyTo, quotes);
    const chat = chatListRef.current.find(item => item.id === id), outside = chat?.type === "channel"
      ? [...new Set(findMentions(content, liveMembers(members)).filter(hit => !chat.memberIds.includes(hit.member.id)).map(hit => hit.member.name))] : [];
    if (outside.length) setNotice(t("app.notInChannel", { names: outside.join(t("common.listSeparator")), count: outside.length }));
    // In the transcript at once; its row comes with the event for it (A72).
    history.heard(sent, true);
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
  /** A thread's pane read, followed or changed it: its row takes the news at once; the numbers come with the event (A72). */
  function threadChanged(thread: Chat) { threadEvents.emit({ kind: "chat", chat: thread }); }
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
      statusVersions.current.clear(); setStatuses({}); setPane(null); setFollowed(null); setChanges(noChanges); memory.clear();
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
  const botDirects = useBotDirects(phase === "ready" ? chats.find(chat => chat.id === selected && chat.type === "dm")?.botId ?? undefined : undefined, unlistedKey(changes));
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
  const cardBot = bots.find(bot => bot.id === botCard?.id);
  const working = new Set(Object.values(statuses).filter(item => item.status === "running" && item.activity !== "asking").map(item => item.botId));
  const asking = new Set(Object.values(statuses).filter(item => item.activity === "asking").map(item => item.botId));
  return <>
    <div className="ui-app" data-nav={mobileNav ? "" : undefined} data-pane={pane && !full && !away ? "" : undefined} data-view={home ? "home" : envs ? "envs" : undefined}
      style={{ ["--ui-pane" as string]: `${paneWidth}px` }}>
      <Rail view={home ? "home" : envs ? "envs" : "chats"} agent={agent} figure={agentFigure} call={agentCall.call} asleep={motionOf(agentStatus).motion === "sleep"} alerts={chats.reduce((sum, chat) => sum + (chat.id === agentDm?.id ? 0 : chat.alerts), 0)} username={username}
        // On a phone the chats tab opens the chat list over the open chat; the list's own rows then open a chat.
        onView={next => { setView(next); setMobileNav(next === "chats" && window.matchMedia("(max-width: 620px)").matches); setAccountMenu(false); }}
        accountMenu={accountMenu} onToggleAccount={open => { setAccountMenu(open); setCreateMenu(false); }}
        onSettings={() => { setAccountMenu(false); setSettingsTab("general"); }}
        onToggleTheme={() => { applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"); setAccountMenu(false); }}
        onLogOut={() => void logOut()}/>
      <AppSidebar chats={chats} sections={sections} bots={bots} members={members} followed={followed} followedOpen={followedView && !full}
        working={working} asking={asking} selected={followedView ? null : selected} filter={filter} creating={creating} createMenu={createMenu}
        onFilterChange={setFilter}
        onOpenFollowed={() => { setFollowedView(true); setPane(null); setMobileNav(false); }} onOpenChat={openChat} onOpenBot={bot => void openBot(bot.id)}
        onOpenMenu={(target, at) => setEntryMenu({ target, at })} onEditSection={section => setDialog({ kind: "section", section })}
        onCreate={what => { if (what === "bot") return void createBot(); setDialog({ kind: what }); setCreateMenu(false); }}
        onFind={find.openMessage} onOpenFound={openAnywhere} onError={handleError}
        onToggleCreate={open => { setCreateMenu(open); setAccountMenu(false); }}/>
      <ChatMain chat={current} inChannel={inChannel} bots={bots} members={members} meId={meId} drafts={drafts} composeReady={composeReady} botName={botName}
        activeBot={activeBot} status={status} connections={connections} activity={activity} history={history} divider={dividers[current?.id ?? ""] ?? current?.readSequence ?? 0} activeQuestion={activeQuestion}
        pane={pane} onPane={setPane} onToggleInfo={toggleInfo} find={find} onNav={() => setMobileNav(true)} onBot={id => setInfoBotId(id)} hasBotDirects={botDirects.length > 0} onBotCard={openBotCard}
        onInvite={invite} onQuote={setReplyFor} onReply={message => void replyInThread(message)} onReact={(message, emoji, on) => void react(message, emoji, on)} onFold={(message, folded) => void fold(message, folded)}
        onJump={jumpTo} onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))}
        onPreview={(files, index) => setPreview({ files, index })} onSend={sendMain} notice={setNotice}
        onSaveNote={async text => { try { chatSaved(await api.setNote(current!.id, text)); } catch (error) { handleError(error); throw error; } }}
        createBot={() => void createBot()} creating={creating} updateBot={updateBot} onManageModels={() => setSettingsTab("models")} error={handleError}
        chatArea={chatArea} transcript={transcript} composeWrap={composeWrap} hidden={full || followedView || away}
        onOpenThread={id => setPane({ kind: "thread", id, parentId: current!.id, mode: "pane" })}/>
      <SidePane onBotCard={openBotCard} pane={pane} followedView={followedView} threadEvents={threadEvents} followed={followed} chats={chats} sections={sections} members={members} bots={bots} statuses={statuses}
        meId={meId} drafts={drafts} changes={changes} live={live} memory={memory} paneChannel={paneChannel} activeBot={activeBot} botDirects={botDirects} find={find}
        onPane={setPane} onNav={() => setMobileNav(true)} onBackToChannel={toChannel} onAddMembers={chat => setDialog({ kind: "members", chat })} onOpenBot={setInfoBotId}
        onPin={chat => void pinChat(chat, !chat.pinned)} onMute={chat => void muteChat(chat, !chat.muted)} onDeleteChannel={chat => setConfirm({ kind: "chat", chat })}
        onChannelSaved={chatSaved} onThreadChanged={threadChanged} onInvite={invite} onPreview={(files, index) => setPreview({ files, index })}
        onNotice={setNotice} onError={handleError} paneWidth={paneWidth} onResize={startResize}/>
      {home && <Home bot={agent} chat={agentDm} status={agentStatus} figure={agentFigure} call={agentCall.call} onSeen={agentCall.seen} meId={meId} members={members} drafts={drafts} live={live} onOpenDm={() => void openBot(agent.id)}
        onBotInfo={() => setInfoBotId(agent.id)} ensureDm={async () => { const chat = await api.createChat(agent.id); chatSaved(chat); return chat; }}
        onRead={(chat, sequence) => readUpTo(setChats, chat.id, sequence, handleError)} onPreview={(files, index) => setPreview({ files, index })} onNotice={setNotice} onError={handleError}/>}
      {envs && <Environments bots={bots} statuses={statuses} adding={addingMachine} onAdding={setAddingMachine} onSaved={updateBot}/>}
    </div>
    {cardBot && botCard && <BotCard bot={cardBot} status={statuses[cardBot.id]} connections={connections} anchor={botCard.anchor} onClose={closeBotCard} onMessage={() => void openBot(cardBot.id)} onInfo={() => setInfoBotId(cardBot.id)}/>}
    {settingsTab && <SettingsDialog connections={connections} bots={bots} initialTab={settingsTab} onChanged={refreshConnections} onClose={() => setSettingsTab(null)}/>}
    <AppDialogs dialog={dialog} entryMenu={entryMenu} confirm={confirm} preview={preview} infoBot={infoBot} bots={bots} statuses={statuses} chats={chats}
      sections={sections} members={members} connections={connections} meId={meId}
      onDialog={setDialog} onEntryMenu={setEntryMenu} onConfirm={setConfirm} onPreview={setPreview} onInfoBot={setInfoBotId} onSettings={setSettingsTab} onAddMachine={() => { setView("envs"); setAddingMachine(true); setMobileNav(false); }}
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
