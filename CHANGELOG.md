# Changelog

All notable changes to Jarvy. Versions follow [semantic versioning](https://semver.org/) as used before 1.0: a patch release only fixes bugs; a minor release adds features or upgrades the database.

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
