import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, ApiError, type Attachment, type BotStatus, type Bot, type Chat, type ChatMessage, type Member, type ModelConnection, type Section, type ThreadEntry } from "./api";
import { BotInfo } from "./BotInfo";
import { Sidebar, hintThread } from "./sidebar/Sidebar";
import { ChannelHeader, ChannelMessages, NoticeBar } from "./channel/ChannelView";
import { AddMembersDialog, NewChannelDialog, SectionDialog } from "./channel/ChannelDialogs";
import { ChannelInfo, type InfoPage } from "./channel/ChannelInfo";
import { findMentions } from "./channel/mentions";
import { Composer } from "./composer/Composer";
import { DraftStore, draftKey, quoteMessage } from "./composer/drafts";
import { ThreadPane } from "./thread/ThreadPane";
import { FollowedThreads, ThreadList } from "./thread/ThreadList";
import { BotDirects, useBotDirects } from "./bot/BotDirects";
import { DmMessages } from "./dm/DmMessages";
import { EntryMenu, type MenuTarget } from "./sidebar/EntryMenu";
import { useTabBadge } from "./tabBadge";
import { liveMembers } from "./members";
import { ConfirmDialog, DeleteBotDialog } from "./dm/DeleteDialog";
import { useTranscript } from "./transcript/useTranscript";
import { Login } from "./Login";
import { SettingsDialog } from "./Settings";
import { ModelPicker } from "./ModelPicker";
import { applyTheme, Icon, IconButton } from "./ui";
import { FloatingBot } from "./avatar/FloatingBot";
import { FileViewer } from "./files/FileViewer";

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
  const [dialog, setDialog] = useState<{ kind: "channel" } | { kind: "members"; chat: Chat } | { kind: "section"; section?: Section } | null>(null);
  /** Read position when each chat was opened: the "以下为新消息" line stays there while you read. */
  const [dividers, setDividers] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [focusedBotId, setFocusedBotId] = useState<string | null>(null);
  const [infoBotId, setInfoBotId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [createMenu, setCreateMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  /** Right-hand pane (A37 P2): a channel's thread list or info (with its member page), or one thread (expandable over the main area). */
  const [pane, setPane] = useState<{ kind: "threads" } | { kind: "info"; page: InfoPage } | { kind: "botdms" } | { kind: "thread"; id: string; parentId: string; mode: "pane" | "full" } | null>(null);
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
  const [entryMenu, setEntryMenu] = useState<{ target: MenuTarget; at: { x: number; y: number } } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "chat"; chat: Chat } | { kind: "bot"; bot: Bot } | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const accountRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLDivElement>(null);
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
  const { messages, setMessages, loading: loadingMessages } = history;

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
      if (status.error && chatListRef.current.find(chat => chat.id === selectedRef.current)?.botId === status.botId) setNotice(status.error);
      if (status.status === "idle" || status.status === "stop") void api.bots().then(result => { if (alive) setBots(result.bots); }).catch(error => { if (alive) handleError(error); });
    });
    source.onerror = () => { void api.me().catch(error => { if (alive && error instanceof ApiError && error.status === 401) setPhase("login"); }); };
    return () => { alive = false; source.close(); history.cancel(); chatRequest.current++; };
  }, [phase]);
  // What is on screen counts as read (A37): move the read position to the last loaded message while visible.
  useEffect(() => {
    const id = selected, last = messages.at(-1);
    if (phase !== "ready" || !id || !last || last.chatId !== id) return;
    const mark = () => {
      const open = chatListRef.current.find(chat => chat.id === id);
      // Reading also counts as having seen the chat's hints (A41): marks on your messages, new notice versions.
      if (document.visibilityState !== "visible" || ((open?.readSequence ?? 0) >= last.sequence && !open?.hint && !open?.alerts)) return;
      setChats(previous => previous.map(chat => chat.id === id ? { ...chat, readSequence: Math.max(chat.readSequence, last.sequence), unread: 0, mentions: 0, alerts: 0, atMe: false, hint: null } : chat));
      void api.markRead(id, last.sequence).catch(handleError);
    };
    mark(); document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [messages, selected, phase, chats.find(chat => chat.id === selected)?.readSequence, chats.find(chat => chat.id === selected)?.alerts, chats.find(chat => chat.id === selected)?.hint]);
  useTabBadge(phase === "ready" ? chats.reduce((sum, chat) => sum + chat.alerts, 0) : 0);
  useEffect(() => {
    if (!accountMenu && !createMenu) return;
    const close = (event: PointerEvent) => {
      if (accountMenu && !accountRef.current?.contains(event.target as Node)) setAccountMenu(false);
      if (createMenu && !createRef.current?.contains(event.target as Node)) setCreateMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountMenu, createMenu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4800);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // Radix owns dialog and nested-picker keyboard handling.
      if (event.defaultPrevented || infoBotId || showSettings) return;
      if (event.key === "Escape") { setAccountMenu(false); setCreateMenu(false); setMobileNav(false); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileNav(window.matchMedia("(max-width: 620px)").matches);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#jarvy-search")?.focus());
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [infoBotId, showSettings]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 620px)");
    const closeOnDesktop = () => { if (!media.matches) setMobileNav(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) { setPhase("login"); return; }
    setNotice(error instanceof Error ? error.message : "操作失败，请重试。");
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
    if (thread) setPane({ kind: "thread", id: thread, parentId: chat.id, mode: "pane" });
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
      const bot = await api.createBot();
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
      setNotice("频道已删除");
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
      setNotice(`${bot.name} 已删除`);
    } catch (error) { handleError(error); }
  }
  async function sendMain(content: string, attachmentIds: string[], key: string, replyTo?: string) {
    const id = selected!;
    await api.send(id, content, attachmentIds, key, false, replyTo);
    const chat = chatListRef.current.find(item => item.id === id), outside = chat?.type === "channel"
      ? findMentions(content, liveMembers(members)).filter(hit => !chat.memberIds.includes(hit.member.id)).map(hit => hit.member.name) : [];
    if (outside.length) setNotice(`${[...new Set(outside)].join("、")} 不在频道中，未收到通知`);
    await Promise.all([refreshTranscript(id), refreshChats()]);
  }
  /** Adds someone picked from the @ menu to the channel (or the thread's channel). */
  function invite(channelId: string, member: Member) {
    void api.addMember(channelId, member.id).then(chat => { chatSaved(chat); setNotice(`${member.name} 已加入 #${chat.title}`); }).catch(handleError);
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
  /** The composer's quote bar: part of the quoted message's chat draft. */
  function setReplyFor(message: ChatMessage) { quoteMessage(drafts, message, members); }
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
      await api.logout(); setPhase("login"); setAccountMenu(false); setShowSettings(false);
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
  const botDirects = useBotDirects(phase === "ready" ? chats.find(chat => chat.id === selected && chat.type === "dm")?.botId : undefined, tick);
  const botColors = new Map(bots.map(bot => [bot.id, { color: bot.color, mood: bot.mood }]));
  if (phase === "loading") return <div className="jarvy-loading">正在连接 Jarvy…</div>;
  if (phase === "login") return <Login onLogin={name => void loadData(name).catch(handleError)}/>;
  const current = chats.find(chat => chat.id === selected);
  const activeBot = bots.find(bot => bot.id === (current?.botId ?? focusedBotId)) ?? bots[0];
  const activeBotReady = !!activeBot?.connectionId;
  // A channel takes messages whether or not its Bots have models; a DM needs its Bot's model first.
  const composeReady = inChannel || activeBotReady;
  const botName = activeBot?.name ?? "Jarvy";
  const status = activeBot ? statuses[activeBot.id] : undefined;
  const activity = status?.error ? "运行出错" : status?.status === "running"
    ? ({ reasoning: "思考中", texting: "处理中", tool_calling: "执行工具", asking: "等你回答" } as Record<string, string>)[status.activity ?? ""] ?? "运行中" : "";
  // Only the latest question still waiting for an answer takes the A–F shortcuts.
  const activeQuestion = [...messages].reverse().find(message => message.question?.state === "pending")?.id;
  const openThread = pane?.kind === "thread" ? pane : null, full = openThread?.mode === "full";
  const paneChannel = inChannel ? viewing : undefined;
  const infoBot = bots.find(bot => bot.id === infoBotId);
  const working = new Set(Object.values(statuses).filter(item => item.status === "running" && item.activity !== "asking").map(item => item.botId));
  const asking = new Set(Object.values(statuses).filter(item => item.activity === "asking").map(item => item.botId));
  return <>
    <div className="ui-app" data-nav={mobileNav ? "" : undefined} data-pane={pane && !full ? "" : undefined} style={{ ["--ui-pane" as string]: `${paneWidth}px` }}>
      <aside className="ui-sidebar" aria-label="会话列表">
        <header className="ui-sidebar-header"><div className="jarvy-sidebar-create" ref={createRef}>
          <IconButton icon="add" label="打开新建菜单" aria-expanded={createMenu} aria-haspopup="menu" disabled={creating} onClick={() => { setCreateMenu(!createMenu); setAccountMenu(false); }}/>
          {createMenu && <div className="ui-popover jarvy-create-menu" role="menu" aria-label="新建菜单">
            <button role="menuitem" className="ui-menu-item" onClick={() => { setDialog({ kind: "channel" }); setCreateMenu(false); }}><Icon name="list-bullets"/><span className="ui-menu-copy">新建频道</span></button>
            <button role="menuitem" className="ui-menu-item" onClick={() => { setDialog({ kind: "section" }); setCreateMenu(false); }}><Icon name="folder"/><span className="ui-menu-copy">新建频道分组</span></button>
            <button role="menuitem" className="ui-menu-item" onClick={() => void createBot()}><Icon name="person-add"/><span className="ui-menu-copy">新建 Bot</span></button>
          </div>}
        </div></header>
        <Sidebar chats={chats} sections={sections} bots={bots} working={working} asking={asking} selected={followedView ? null : selected} filter={filter} onFilterChange={setFilter}
          followed={followed} followedOpen={followedView && !full} onOpenFollowed={() => { setFollowedView(true); setPane(null); setMobileNav(false); }}
          onSelect={openChat} onOpenBot={bot => void openBot(bot.id)} onMenu={(target, at) => setEntryMenu({ target, at })}
          onEditSection={section => setDialog({ kind: "section", section })}/>
        <footer className="ui-sidebar-footer"><button type="button" className="ui-footer-entry" aria-label={`用户菜单，${username}`} aria-expanded={accountMenu} onClick={() => { setAccountMenu(!accountMenu); setCreateMenu(false); }}>
          <span className="ui-user-avatar">{username.slice(0, 2).toUpperCase()}</span><span>{username}</span><Icon name="chevron-down"/>
        </button></footer>
      </aside>
      {followedView && !full && <FollowedThreads threads={followed} chats={chats} members={members} bots={bots} onNav={() => setMobileNav(true)}
        renderThread={(thread, back) => <ThreadPane key={thread.id} threadId={thread.id} mode="embed" channel={chats.find(chat => chat.id === thread.parentId)} drafts={drafts}
          members={members} bots={bots} me={meId} tick={tick} onNav={() => setMobileNav(true)} onChanged={threadChanged}
          onClose={back} onToggleMode={() => toChannel({ id: thread.id, parentId: thread.parentId! }, true)}
          onInvite={member => invite(thread.parentId!, member)} onPreview={(list, index) => setPreview({ files: list, index })}
          onError={handleError} onNotice={setNotice}/>}/>}
      <main className="ui-chat" aria-label="对话区域" ref={chatArea} hidden={full || followedView}>
        {!inChannel && <IconButton icon="layout-sidebar-left" className="ui-mobile-only jv-floating-nav" label="打开会话列表" onClick={() => setMobileNav(true)}/>}
        {!inChannel && botDirects.length > 0 && <IconButton icon="people" className="jv-floating-dms" label={`${botName} 的 Bot 私聊`} aria-pressed={pane?.kind === "botdms"}
          onClick={() => setPane(pane?.kind === "botdms" ? null : { kind: "botdms" })}/>}
        <span className="sr-only" role="status" aria-label="Bot 状态">{inChannel ? "" : activity}</span>
        {current ? <>
          {inChannel ? <ChannelHeader chat={current} members={liveMembers(members)} bots={bots} onNav={() => setMobileNav(true)}
            infoOpen={pane?.kind === "info" && pane.page === "main"} onInfo={() => toggleInfo("main")}
            membersOpen={pane?.kind === "info" && pane.page === "members"} onMembers={() => toggleInfo("members")}
            threadsOpen={pane?.kind === "threads"} onThreads={() => setPane(pane?.kind === "threads" ? null : { kind: "threads" })}/>
            : activeBot && <FloatingBot bot={activeBot} status={status} area={chatArea} avoid={composeWrap} onOpen={() => setInfoBotId(activeBot.id)}/>}
          {inChannel && <NoticeBar chat={current} onSave={async text => { try { chatSaved(await api.setNote(current.id, text)); } catch (error) { handleError(error); throw error; } }}/>}
          <div className={`ui-transcript jarvy-transcript${inChannel ? " jv-channel-transcript" : ""}`} ref={transcript} aria-label="聊天记录" role="log">
            {!inChannel && !activeBot?.connectionId && activeBot && <div className="jarvy-model-onboarding"><ModelPicker bot={activeBot} connections={connections} onSaved={updateBot} onManage={() => setShowSettings(true)}/></div>}
            {loadingMessages ? <p className="jarvy-empty-text">正在读取会话…</p> : messages.length === 0
              ? inChannel ? <div className="jarvy-empty-chat"><p>暂无消息</p></div>
              : activeBot?.connectionId ? <div className="jarvy-empty-chat"><h2>与 {botName} 开始对话</h2></div> : null : <>
              {history.hasOlder && <div ref={history.top} className="jv-history-more" aria-live="polite">{history.loadingOlder ? "正在加载更早的消息…" : ""}</div>}
              <p className="jarvy-date-stamp">{new Date(messages[0]!.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</p>
              {inChannel ? <ChannelMessages messages={messages} members={members} bots={bots} me={meId} divider={dividers[current.id] ?? current.readSequence} activeQuestion={activeQuestion}
                onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))} onPreview={(list, index) => setPreview({ files: list, index })}
                onReply={message => void replyInThread(message)} onOpenThread={id => setPane({ kind: "thread", id, parentId: current.id, mode: "pane" })}
                onQuote={setReplyFor} onReact={(message, emoji, on) => void react(message, emoji, on)} onJump={id => void history.toMessage(id)} onError={handleError}/>
              : <DmMessages messages={messages} members={members} colors={botColors} me={meId} activeQuestion={activeQuestion} bot={activeBot}
                onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))} onPreview={(list, index) => setPreview({ files: list, index })}
                onQuote={setReplyFor} onReact={(message, emoji, on) => void react(message, emoji, on)} onJump={id => void history.toMessage(id)} onError={handleError}/>}
            </>}
            {history.away && messages.length > 0 && <div className="jv-to-latest"><button type="button" onClick={history.toLatest} aria-label="回到最新消息">
              {history.unseen > 0 && <span>{history.unseen} 条新消息</span>}<Icon name="chevron-down"/></button></div>}
          </div>
          <Composer chatId={current.id} id="jarvy-composer" drafts={drafts} formRef={composeWrap} scrollRef={transcript} disabled={!composeReady}
            placeholder={inChannel ? `发消息到 #${current.title}` : activeBot?.connectionId ? `发消息给 ${botName}…` : "先选择模型，再发送消息"}
            mention={inChannel ? { bots, inside: liveMembers(members).filter(member => member.id !== meId && current.memberIds.includes(member.id)),
              outside: liveMembers(members).filter(member => !current.memberIds.includes(member.id)), onInvite: member => invite(current.id, member) } : undefined}
            onSend={sendMain} onError={handleError} onNotice={setNotice}/>
        </> : <div className="jarvy-empty-chat jarvy-first-chat">{bots.length ? <p>选择一个会话</p>
          : <button className="ui-button ui-primary" onClick={() => void createBot()} disabled={creating}><Icon name="person-add"/>新建 Bot</button>}</div>}
      </main>
      {openThread && <ThreadPane key={openThread.id} threadId={openThread.id} mode={openThread.mode} channel={chats.find(chat => chat.id === openThread.parentId)} drafts={drafts}
        members={members} bots={bots} me={meId} tick={tick} onNav={() => setMobileNav(true)} onChanged={threadChanged}
        onClose={() => full ? toChannel(openThread, false) : setPane(null)} onToggleMode={() => full ? toChannel(openThread, true) : setPane({ ...openThread, mode: "full" })}
        onInvite={member => invite(openThread.parentId, member)} onPreview={(list, index) => setPreview({ files: list, index })}
        onError={handleError} onNotice={setNotice}/>}
      {pane?.kind === "threads" && paneChannel && <ThreadList channel={paneChannel} members={members} bots={bots} tick={tick}
        onOpen={id => setPane({ kind: "thread", id, parentId: paneChannel.id, mode: "pane" })} onClose={() => setPane(null)} onError={handleError}/>}
      {pane?.kind === "info" && paneChannel && <ChannelInfo channel={paneChannel} page={pane.page} sections={sections} members={liveMembers(members)} bots={bots}
        statuses={statuses} me={meId} onPage={page => setPane({ kind: "info", page })} onPin={() => void pinChat(paneChannel, !paneChannel.pinned)}
        onMute={() => void muteChat(paneChannel, !paneChannel.muted)} onAdd={() => setDialog({ kind: "members", chat: paneChannel })}
        onBot={id => setInfoBotId(id)} onDelete={() => setConfirm({ kind: "chat", chat: paneChannel })} onChanged={chatSaved}
        onClose={() => setPane(null)} onError={handleError}/>}
      {pane?.kind === "botdms" && activeBot && !inChannel && <BotDirects bot={activeBot} chats={botDirects} members={members} bots={bots} me={meId} tick={tick}
        onClose={() => setPane(null)} onPreview={(list, index) => setPreview({ files: list, index })} onError={handleError}/>}
      {pane && !full && <div className="jv-resize" style={{ right: paneWidth - 4 }} onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="拖动调整侧栏宽度"/>}
      {accountMenu && <div ref={accountRef} className="ui-popover jarvy-account-menu" role="menu" aria-label="账户菜单">
        <div className="ui-menu-note ui-small">{username}</div>
        <button role="menuitem" className="ui-menu-item" onClick={() => { setAccountMenu(false); setShowSettings(true); }}><Icon name="gear"/><span className="ui-menu-copy">设置</span></button>
        <button role="menuitem" className="ui-menu-item" onClick={() => { applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"); setAccountMenu(false); }}><Icon name="moon"/><span className="ui-menu-copy">切换主题</span></button>
        <hr className="ui-menu-divider"/>
        <button role="menuitem" className="ui-menu-item" onClick={() => void logOut()}><Icon name="arrow-bracket-to-left"/><span className="ui-menu-copy">退出登录</span></button>
      </div>}
    </div>
    {mobileNav && <div className="ui-nav-scrim" onClick={() => setMobileNav(false)} role="presentation"/>}
    {showSettings && <SettingsDialog connections={connections} onChanged={refreshConnections} onClose={() => setShowSettings(false)}/>}
    {dialog?.kind === "channel" && <NewChannelDialog sections={sections} members={liveMembers(members)} bots={bots} me={meId}
      onClose={() => setDialog(null)} onSaved={chat => { chatSaved(chat); setDialog(null); openChat(chat); }}/>}
    {dialog?.kind === "members" && <AddMembersDialog chat={chats.find(chat => chat.id === dialog.chat.id) ?? dialog.chat} members={liveMembers(members)} bots={bots}
      onClose={() => setDialog(null)} onChanged={chatSaved}/>}
    {dialog?.kind === "section" && <SectionDialog section={dialog.section} onClose={() => setDialog(null)}
      onSaved={section => { setSections(previous => previous.some(item => item.id === section.id) ? previous.map(item => item.id === section.id ? section : item) : [...previous, section]); setDialog(null); }}
      onDeleted={id => { setDialog(null); setSections(previous => previous.filter(item => item.id !== id)); void refreshChats().catch(handleError); }}/>}
    {entryMenu && <EntryMenu target={entryMenu.target} x={entryMenu.at.x} y={entryMenu.at.y} onClose={() => setEntryMenu(null)}
      onOpenBot={bot => setInfoBotId(bot.id)} onSettings={chat => { if (chat.type !== "channel") return; openChat(chat); setPane({ kind: "info", page: "main" }); }}
      onPin={pinChat} onMute={muteChat} onDeleteChat={chat => setConfirm({ kind: "chat", chat })} onDeleteBot={bot => setConfirm({ kind: "bot", bot })}/>}
    {confirm?.kind === "chat" && <ConfirmDialog title={`删除频道 #${confirm.chat.title}`} confirm="删除" onClose={() => setConfirm(null)}
      body="频道里的消息、线程和附件都会删除。" onConfirm={async () => { await removeChannel(confirm.chat); setConfirm(null); }}/>}
    {confirm?.kind === "bot" && <DeleteBotDialog bot={confirm.bot} chats={chats.filter(chat => chat.type === "dm" && chat.botId === confirm.bot.id).length}
      onClose={() => setConfirm(null)} onConfirm={async deleteFiles => { await deleteBot(confirm.bot, deleteFiles); setConfirm(null); }}/>}
    {infoBot && <BotInfo key={infoBot.id} bot={infoBot} status={statuses[infoBot.id]} connections={connections} chats={chats} onSaved={updateBot} onOpenChat={id => { setSelected(id); setInfoBotId(null); setMobileNav(false); }} onOpenSubscription={openAnywhere} onManageModels={() => { setInfoBotId(null); setShowSettings(true); }} onClose={() => setInfoBotId(null)}/>}
    {preview && <FileViewer files={preview.files} initialIndex={preview.index} onClose={() => setPreview(null)}/>}
    {notice && <div className="ui-toast" role="status">{notice}</div>}
    {DevAgentation && <Suspense fallback={null}><DevAgentation appName="Jarvy" className="jarvy-dev-annotation" enableKeyboardShortcuts={false}/></Suspense>}
  </>;
}
