import type { Attachment, Chat, Member, Section } from "../contract/chat";
import type { Bot, BotStatus } from "../contract/bots";
import type { ModelConnection } from "../contract/models";
import { BotInfo } from "./BotInfo";
import { AddMembersDialog, NewChannelDialog, SectionDialog } from "./channel/ChannelDialogs";
import { DeleteBotDialog, ConfirmDialog } from "./dm/DeleteDialog";
import { EntryMenu, type MenuTarget } from "./sidebar/EntryMenu";
import { FileViewer } from "./files/FileViewer";
import { liveMembers } from "./members";
import { t } from "./i18n";
import type { SettingsOpen } from "./Settings";

export type Dialog = { kind: "channel" } | { kind: "members"; chat: Chat } | { kind: "section"; section?: Section } | null;
export type Menu = { target: MenuTarget; at: { x: number; y: number } } | null;
export type Confirm = { kind: "chat"; chat: Chat } | { kind: "bot"; bot: Bot } | null;

/** App's dialogs and popovers over everything: new channel, add members, channel groups, the sidebar row's menu, the
 * two delete confirmations, Bot info and the file viewer. App owns which one is open. */
export function AppDialogs({ dialog, entryMenu, confirm, preview, infoBot, bots, statuses, chats, sections, members, connections, meId,
  onDialog, onEntryMenu, onConfirm, onPreview, onInfoBot, onSettings, onChannelInfo, onOpenChatId, chatSaved, openChat, onSectionSaved, onSectionDeleted,
  updateBot, openAnywhere, removeChannel, deleteBot, pinChat, muteChat }: {
  dialog: Dialog; entryMenu: Menu; confirm: Confirm; preview: { files: Attachment[]; index: number } | null;
  infoBot: Bot | undefined; bots: Bot[]; statuses: Record<string, BotStatus>; chats: Chat[]; sections: Section[]; members: Member[];
  connections: ModelConnection[]; meId: string;
  onDialog: (dialog: Dialog) => void; onEntryMenu: (menu: Menu) => void; onConfirm: (confirm: Confirm) => void;
  onPreview: (preview: { files: Attachment[]; index: number } | null) => void; onInfoBot: (id: string | null) => void;
  /** The sidebar row's 「频道信息」: the chat, and channel info in the pane. */
  onChannelInfo: (chat: Chat) => void;
  /** Bot info's chat list opens a chat in the main area. */
  onOpenChatId: (id: string) => void;
  /** Bot info opens Settings: 管理模型 the model page, 添加机器 the form to add a machine. */
  onSettings: (open: SettingsOpen) => void;
  chatSaved: (chat: Chat) => void; openChat: (chat: Chat) => void;
  onSectionSaved: (section: Section) => void; onSectionDeleted: (id: string) => void;
  updateBot: (bot: Bot) => void; openAnywhere: (chat: Chat) => void;
  removeChannel: (chat: Chat) => Promise<void>; deleteBot: (bot: Bot, deleteFiles: boolean) => Promise<void>;
  pinChat: (chat: Chat, pinned: boolean) => Promise<void>; muteChat: (chat: Chat, muted: boolean) => Promise<void>;
}) {
  return <>
    {dialog?.kind === "channel" && <NewChannelDialog sections={sections} members={liveMembers(members)} bots={bots} me={meId}
      onClose={() => onDialog(null)} onSaved={chat => { chatSaved(chat); onDialog(null); openChat(chat); }}/>}
    {dialog?.kind === "members" && <AddMembersDialog chat={chats.find(chat => chat.id === dialog.chat.id) ?? dialog.chat} members={liveMembers(members)} bots={bots}
      onClose={() => onDialog(null)} onChanged={chatSaved}/>}
    {dialog?.kind === "section" && <SectionDialog section={dialog.section} onClose={() => onDialog(null)} onSaved={onSectionSaved} onDeleted={onSectionDeleted}/>}
    {entryMenu && <EntryMenu target={entryMenu.target} x={entryMenu.at.x} y={entryMenu.at.y} onClose={() => onEntryMenu(null)}
      onOpenBot={bot => onInfoBot(bot.id)} onSettings={chat => { if (chat.type === "channel") onChannelInfo(chat); }}
      onPin={(chat, pinned) => void pinChat(chat, pinned)} onMute={(chat, muted) => void muteChat(chat, muted)}
      onDeleteChat={chat => onConfirm({ kind: "chat", chat })} onDeleteBot={bot => onConfirm({ kind: "bot", bot })}/>}
    {confirm?.kind === "chat" && <ConfirmDialog title={t("app.deleteChannelTitle", { name: confirm.chat.title })} confirm={t("common.delete")} onClose={() => onConfirm(null)}
      body={t("app.deleteChannelBody")} onConfirm={async () => { await removeChannel(confirm.chat); onConfirm(null); }}/>}
    {confirm?.kind === "bot" && <DeleteBotDialog bot={confirm.bot} chats={chats.filter(chat => chat.type === "dm" && chat.botId === confirm.bot.id).length}
      onClose={() => onConfirm(null)} onConfirm={async deleteFiles => { await deleteBot(confirm.bot, deleteFiles); onConfirm(null); }}/>}
    {infoBot && <BotInfo key={infoBot.id} bot={infoBot} status={statuses[infoBot.id]} connections={connections} chats={chats} onSaved={updateBot}
      onOpenChat={id => { onInfoBot(null); onOpenChatId(id); }} onOpenSubscription={openAnywhere}
      onManageModels={() => { onInfoBot(null); onSettings("models"); }} onAddMachine={() => { onInfoBot(null); onSettings("addMachine"); }} onClose={() => onInfoBot(null)}/>}
    {preview && <FileViewer files={preview.files} initialIndex={preview.index} onClose={() => onPreview(null)}/>}
  </>;
}
