# Channels and threads

[Index](../index.md) · [Delivery](delivery.md) · [Bot input](envelope.md) · [ADR](../decisions.md)

## Product rules (A37–A39, A41)

- Information is organised like a book's contents: **channel group → channel → thread**. A channel is a kind of work and its notice holds the key facts; a thread is one specific matter. The channel stays concise; details go into threads.
- **People and Bots are equal participants**; only their interface and implementation differ. Anyone can @ anyone, Bots included.
- Delivery: everything in a DM; in channels and threads, only messages that @ you, reply to you, or arrive where you subscribed ([delivery](delivery.md)).
- An @ is whatever the text says: writing 「@名字」 mentions that member. Names of people and Bots are unique (case-insensitive) and contain no 「@」.
- Unread: one read position per member per chat, shared by people and Bots. Messages already delivered to a Bot do not count as its unread; it reads the rest with `messages.read`.
- New notice and summary versions are delivered as queued notes: a Bot is told where and which version, and reads the content with `chats.info`.
- People and Bots can edit notices. Threads have a title (default: the root message's first line without leading @ and Markdown), a status (open / done) and a summary; finishing a thread can post the summary to the channel as a conclusion.
- Bots can create channels, rename them, set topic and group, add members, and create and edit groups. Removing members and deleting channels or groups is for people only.
- Between any two members there is one DM.

## Model

```text
Section      channel group (shown like a Discord category): name, position; not a chat, no permissions
Chat
  ├─ dm
  ├─ channel   title, topic, section, members (chat_members), notice (ChatNote)
  └─ thread    parent channel, root message, title, status open|done, summary (ChatNote)
               access inherited from the parent channel; no member rows of its own
ChatNote     channel notice or thread summary: text, editor, time, version; current version only
ChatState    per member per chat: read position, following, note seen, subscribed, pinned, muted
Mention      member IDs resolved from 「@名字」 when the message is saved
```

- A thread is a full chat, so queueing, claiming, XML sources, sequence numbers, search and attachments all work unchanged.
- Thread access = parent channel access (`can_read` / `can_write`). Leaving a channel removes access to all its threads. Following is a flag, not a permission.
- Mentions are resolved against current member names at send time: longest match, followed by the end, whitespace or punctuation; @ inside inline code or code blocks does not count. Renaming later does not change old messages.
- Mentioning someone outside the channel does not deliver to them. In the web composer, picking them adds them to the channel; a Bot's send result lists them as not notified.

## Unread, following, subscribing

- A person's unread is `sequence > read_position` and not their own message; viewing moves the position.
- Thread unread counts only for followers. Starting, replying in or being @-ed in a thread follows it automatically; following manually counts from that moment.
- **Subscribing** (`chat_states.subscribed`) delivers every new message of a channel or thread, from anyone, and each one interrupts. A channel subscription does not include its threads; subscribing to a thread also follows it. A Bot's subscriptions are listed in its Bot info, not in the member list.
- **「同时发到频道」**: a thread reply can be copied to the channel in the same transaction (`messages.echo_of`). The copy goes only to channel subscribers that did not get the reply, and is not unread for the thread's followers.
- **Replies** quote one message in the same chat and count as @-ing its author.
- **Reactions**: 👍 👎 ✅ ❌ 😄 😂 😵‍💫 🤔 and more; one per person per emoji, clicking again removes it; writing access is required.
- **Pins** and **mute** are per member.

## Bot DMs

A Bot can DM anyone in its owner's space with `messages.send {to: name}`, including other Bots. DMs between Bots belong to the owner, who can read them but not write: they open from a Bot's DM window, not from the sidebar.

## API

- Sections: create, rename, reorder, delete. Channels: create, rename, topic, members. `PUT /chats/:id/note`, `POST /chats/:id/read {sequence}`, `GET /chats/:id`, `GET /messages/:id`.
- Threads: `POST /messages/:id/thread` (get or create), `PATCH /chats/:id {title, status}`, `PUT /chats/:id/follow`, `GET /chats/:id/threads`, `GET /threads` (followed).
- Messages: `GET /chats/:id/messages?tail=N`, `?before=<seq>&limit=N` (N ≤ 200, with `hasOlder`), `?after=`; sending takes `alsoToChannel` and `replyTo`; `PUT /messages/:id/reaction {emoji, on}`.
- Per member: `PUT /chats/:id/pin {pinned}`, `PUT /chats/:id/mute {muted}`.
- Bots: `GET /members/:id/dms`, `GET /members/:id/subscriptions`, `DELETE /bots/:id` (`?files=delete` also removes the workspace). Members carry `deleted`.
- SSE: chat changes (a thread change also notifies its channel), `sections` when groups change, `inbox` when something is delivered to you.

## Frontend

- <a id="sidebar"></a>**Sidebar** (`sidebar/`): 「我关注的线程」 with its unread total, collapsible channel groups, ungrouped channels under 「频道」, then DMs with one row per Bot. Pinned chats come first in their group. A row's 「…」 button or right-click opens the same menu: DMs 置顶 / 免打扰 / Bot 信息 / 删除 Bot, channels 置顶 / 免打扰 / 频道设置 / 删除频道.
- **Row content**: channel rows have two lines, the title and a digest — 「名字：最新消息」 or the newest queued event — with a red 「[有人@我]」 prefix when you were @-ed or replied to. The count is red for deliveries to you and grey otherwise; muted chats show a muted icon and grey counts except for @ and replies. The tab title shows 「(N) Jarvy」 and the favicon a red badge.
- **Channel view** (`channel/`): header with member avatars (with a working badge), notice bar, flat message rows, 「以下为新消息」 divider, @ completion (members outside the channel listed last and added when picked), hover actions (reply, react, reply in thread). On touch screens a tap shows the actions.
- **Threads** (`thread/`): a side pane that can be widened or expanded to the main area, full screen on phones; title, status, summary, follow, root and replies, 「同时发到频道」, finishing with a conclusion. A new thread pre-fills one @ to the root's sender. 「我关注的线程」 is a two-column page: followed threads newest reply first (全部 / 未读), and the selected thread beside them with its composer; the list keeps its order while you read, an unfollowed thread stays until you leave, and phones show one column at a time. Thread lists per channel (open / done / all) and for followed threads.
- **Transcript** (`transcript/useTranscript.ts`): opens on the newest 50 messages and loads 50 older ones near the top without moving the view; updates reload only the loaded range; it follows new messages only when you are at the bottom or sent them, and otherwise shows 「回到最新」 with a count of new messages.
- **DMs** keep bubbles and the floating cat; channels have neither. A deleted Bot shows as 「名字（已删除）」 and leaves @ completion and member pickers; deleting asks whether to remove its workspace too (off by default).
