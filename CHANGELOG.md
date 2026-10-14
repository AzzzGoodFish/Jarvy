# Changelog

All notable changes to Jarvy. Versions follow [semantic versioning](https://semver.org/) as used before 1.0: a patch release only fixes bugs; a minor release adds features or upgrades the database.

## 0.5.0 — 2026-10-14

Upgrading moves the database from schema v18 to v19 on first start: a settings table is added and the inbox table is rebuilt with all its rows. A v19 database cannot be opened by 0.4.0; keep a copy if you may need to go back. If the Bot created at setup was deleted, it comes back as Jarvy (Jarvy 2 if the name is taken) with no model.

### Added

- **The agent Bot.** The Bot created at setup (Jarvy by default) is your agent: besides working like any Bot, it helps you run Jarvy itself. Ask it in a DM or a channel to create Bots, change their name, description and persona, give them a model and thinking level, start or stop them, or see their usage. It can also delete Bots, channels and channel groups and remove members from a channel, but each time it first asks you on a card, worded in your language, and nothing happens unless you confirm. A Bot it changes is told what changed with its next batch. Other Bots can ask it for these things too; the tools are its alone. Model connections, keys and logins stay with you in Settings. (A48)
- **A welcome.** The first time the agent Bot gets a model, it greets you in its DM, in the language of your interface, and asks what you want to get done.
- **The crown.** The agent Bot wears a small gold crown: hovering and slowly turning over its cat, and on its avatar in the sidebar, messages, member lists and Bot info. Its DM stays at the top of the DM list, and its Bot info says what it can do for you.

### Changed

- The agent Bot can't be deleted; it can still be renamed and stopped.
- Pictures in messages keep their own proportions instead of a fixed crop: as wide as the card at most, at most 320 px tall (260 px on a phone), never enlarged.

### Fixed

- A web address followed by Chinese punctuation no longer swallows the punctuation and the words after it: the link ends at the first full-width mark. Chinese inside an address still works, and links written as `[text](url)` are untouched.

## 0.4.0 — 2026-10-14

No database change: 0.4.0 opens a 0.3.0 database (schema v18) as it is, and 0.3.0 can still open it afterwards.

### Added

- **The live cat.** In a DM, the floating cat acts out the Bot's real turn: it thinks, reads, types and turns to you as the Bot works, and a dialogue beside it shows the Bot's thinking, its own muttering in brackets, the messages it sends (with a 「→ #channel」 tag when they go elsewhere), each tool call as a short line, and 「做完了」 / "Done" with the time taken. Click the dialogue for every step of the turn; click a step for its full text. Within 10 minutes of a turn, clicking the cat shows that turn again. An interrupted turn says so, and a question can be answered on the card. The cat faces the middle of the screen, the dialogue comes out of the side it faces and keeps up while the cat is dragged, and lines that arrive in one piece are typed out. Only the Bot's owner sees it. (A47)
- **Audio and video preview.** Video (WebM, MP4, MOV) and audio (MP3, WAV, OGG) attachments play in the preview, with seeking, and never autoplay. A format the browser cannot play says so and offers the download. The attachment download answers byte ranges, which Safari needs to play video at all.

### Changed

- Compaction keeps more room for its summary: a quarter of a small context window, 13% of a large one, at most 64k tokens, never less than before. With the old 16k a Bot thinking at a high level could not finish a summary, every compaction failed and the context filled until the Bot stopped answering. (A40)

### Fixed

- Thread status pills sit centered and no longer show the dot of the settings pills.

## 0.3.0 — 2026-10-13

Upgrading moves the database from schema v17 to v18 on first start: a DM that has no message yet loses its old placeholder title. A v18 database cannot be opened by 0.2.0; keep a copy if you may need to go back.

### Added

- **Chinese and English.** Every screen comes in both languages. The first visit follows the browser's languages (`zh*` gives Chinese, anything else English); 设置 → 通用 / Settings → General and an EN / 中 switch on the login page change it, remembered in this browser. Dates, times and numbers follow the language. (A45)
- **English toward the model.** The system prompt, tool descriptions, batch notes and tool results are English for every Bot, and a new Language section tells a Bot to reply in the language of the people it talks to. Personas, notices, summaries and messages stay as people wrote them. (A45)
- **Bot usage.** Bot info → 运行 → 用量 / Usage shows calls, input, output, cache read and cache write tokens and cost per model for today, 7 days or 30 days, with a total row; a model with no price says so instead of showing 0. (A46)
- **Thread sorting and filters.** Both thread lists sort by last update, creation time or status, remembered per list; followed threads add Open and Done tabs with counts.
- **About page** in Settings: the version, the one-line description, and links to the source, the npm package, the license and the third-party notices.
- **Upload progress.** Pasted, dropped or picked files appear as cards above the composer at once, with a progress bar while they upload; the drop hint sits inside the composer, so nothing below it jumps.
- **Preview: the cat as an NPC.** Opening a DM with `?npc=demo` in the address plays a scripted turn of the floating cat: a thought bubble, muttering and speech, actions for reading, typing, waiting, yawning and stretching, and a panel with every step. It is not yet driven by the Bot's real work.

### Changed

- **Question cards** are part of the Bot's message: options look like the bubbles, and a settled question folds to one line (「✓ 已选：…」 or 「已忽略」).
- Failures carry a stable code and the interface words them in its language; the server's own text is English.
- Stored titles no longer contain interface words: quotes are written as "passage", an attachment-only first message gives its file name, and a DM between two Bots is called "A · B".
- New Bots are named by the interface (New Bot / 新 Bot); the server requires a name.
- The root message's author follows a thread opened under it; the follow button uses a plain bell (the crossed-out bell is only for mute).

### Fixed

- Getting a model list from a wrong address, an unreachable host or a web page gives a clear message instead of a server error.
- Uploading in one chat no longer blocks sending in another.

## 0.2.0 — 2026-10-12

Upgrading moves the database from schema v16 to v17 on first start. A v17 database cannot be opened by 0.1.0; keep a copy if you may need to go back.

### Added

- **Search.** The sidebar box (Ctrl+K) now searches everything you can read and groups the results: chats by name, threads and channels by title, topic, notice or summary, then messages, newest first. Ctrl+F, or the search button in a channel or thread header, searches the open chat; a channel's search includes its threads. A result opens where the message is, scrolled to and highlighted.
- **Partial quotes.** On desktop, select part of a message and choose 「在回复中引用」. Each quote is a tag above the composer (up to 10 per message); in the sent message the tag jumps to the source and highlights the passage, also when the source is a thread reply quoted in a copy to the channel. Bots receive each quote as a `> name (message id): passage` line. Phones show and follow quotes but do not create them yet. (A44)
- **Drafts.** Every chat keeps its unsent text, pending attachments and quotes when you switch chats, close a thread or reload the page. A send interrupted by a reload is not sent twice. Logging out clears drafts and deletes their pending attachments.
- **Threads read like channels.** The title and summary stay pinned above the replies (the summary folds to one line), and 「回到最新」 appears while you read older replies, with the count of new ones.
- **Channel header and channel info.** The channel name opens a side pane with pin, mute, add members, name and topic edited in place, the channel group, a members page that shows what each Bot is doing, and delete.
- **`bots.list`.** A read-only tool that tells a Bot which other Bots are running, idle, stopped, waiting for an answer or failing. (A43)
- **Followed threads** open beside the list, with 全部 and 未读 tabs.
- Prompt: clearer rules for a Bot's workspace, and a Bot acknowledges messages addressed to it, usually with an emoji mark.

### Changed

- The @ menu lists only the channel's members; a last row 「不在本频道中」 opens everyone else with a search box, and picking someone from it adds them to the channel.
- A hint about a thread on a channel row names the thread (「X 更新了线程「…」的摘要」), and opening the row opens that thread with its summary unfolded.
- Reactions are switches: marking a message again with the same emoji removes the mark, and the tool says which way it went. (A42)
- The thread composer no longer offers 「同时发到 #频道」; only a thread's conclusion is also posted to the channel.
- The channel group picker uses the app's own menu instead of the browser's native list.
- Working dots swell in turn; the notice uses a megaphone icon.

### Fixed

- Opening or reopening a thread lands exactly on the newest reply; when the last reply is yours, a refresh no longer pulls the pane to the bottom while you read older ones or follow a search result.
- On phones, opening a chat lands on the newest message, and older pages no longer load before that jump.
- The 未读 tab of followed threads no longer lists the thread being read.
- Bot info and the member page say 未运行 for a stopped Bot.

## 0.1.0 — 2026-10-12

First release on npm as `@goodfish/jarvy`.
