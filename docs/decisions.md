# Decisions (ADR)

[Index](index.md)

Each entry records a decision, why it was made and what follows from it. Code comments cite these numbers. Changing a decision means amending its entry (or adding a new one) with the reason and what it replaces — never quietly reverting.

## Foundations

| ADR | Decision | Consequences |
| --- | --- | --- |
| A01 Bot first | Polish one Bot's environment, memory and chat on top of Pi; do not copy a team platform. | DMs came first; channels and threads followed later (A37). |
| A02 Chat domain | Member → User / Bot. Members send and receive; a Chat stores and distributes; a Bot is an object with behaviour. | One identity model for authors. Services do the I/O; no SQL, web or Pi inside entities. |
| A03 One context | One Pi session per Bot, shared across its chats. | Replaces "one session per chat". A Bot executes serially; activity from many chats belongs to its runs. |
| A04 Queue-driven | A message and its deliveries are saved in one transaction; dispatch only notifies; the Bot claims whatever is pending. | Pending messages become one XML prompt, not one prompt per message. Claim state is persistent. |
| A05 Interrupt | New input aborts the running turn and starts a new one at a safe boundary. | No mixing of Pi steer / follow-up for messages; no pre-splitting of batches. Queued deliveries use steer (A39, A41). |
| A06 Speaking | Only a successful `chat` send creates a chat message; `text_delta` is `texting` activity. A Bot may speak in any chat it can access. | No automatic reply to the source chat; no notice when a turn ends without speaking. |
| A07 Tools and prompt | `chat` exposes only `list / describe / call`; Pi's `bash / read / edit / write` stay. The Chinese prompt template comes from the maintainer. | The Pi extension is an adapter detail. No tool schemas or product name in the prompt; prompt wording changes need agreement. |
| A08 Storage ownership | SQLite holds business data and credentials; Pi owns its JSONL; workspaces are separate; default root `~/.jarvy`. | `JARVY_DATA_DIR` replaces the whole root. Session files are explicit `sessions/<timestamp>.jsonl`. |
| A09 Model connections | `connectionId` is the key; `provider_name` may repeat; each connection has its own credential and models. | Several accounts per provider. A Bot is given only its current model and credential, in memory. |
| A10 Model switching | Update state after `await setModel()` succeeds. | No connection test or model check, no optimistic display; partial failures are reconciled. Timing changed by A28. |
| A11 Lazy start | `run` starts no Bots; a new Bot picks a model and waits for the first message. | No automatic greeting. |
| A12 Search and memory | The goal is that everything readable can be searched; an index never replaces Pi's own history. | Scope narrowed by A21; full search not built. |
| A13 Product UI | Reuse shadcn/ui; follow Pi Web's model flows; no development notes in the UI. | No placeholder screens. |
| A14 Engineering rules | Adopt the ten [engineering principles](engineering-principles.md). | Domain first, ≤ 500-line files, clear boundaries, isolation, verifiable changes, delete over compatibility. |
| A15 Compact envelope | XML defines chats and members once per batch and refers to them by ID. | Smaller prompts with unambiguous sources ([format](architecture/envelope.md)). |

**Replaced along the way:** listening on `0.0.0.0` by default (now `127.0.0.1`); Bots as configuration with a session per chat (A02/A03); four direct chat tools (A07); replies only to the source chat and `text_delta` as messages (A06); provider type as key and injecting every model of a connection (A09); welcome messages, optimistic switching, connection tests and batch pre-splitting; treating the workspace as an OS sandbox.

## A16 Keep Pi's defaults; discuss new boundaries first

Model requests, retries, compaction and cancellation are left to Pi; Jarvy keeps only message persistence, delivery and serial session use. A new interception or recovery behaviour is proposed with its real scenario first — a transient 503 retry is not the same as replaying a batch that already sent messages or wrote files. There are no unit tests; changes are verified by building and running real flows.

## A17 `auto` thinking is an intent

`thinkingLevel` can be `auto`; the adapter resolves it to a level the model supports, the API reports `effectiveThinkingLevel` and run snapshots store the resolved level. New Bots default to `auto`. **Why:** writing the resolved level back would lose "follow the default" on the next switch or restart. Thinking level changes call Pi's setter without `setModel`. Pi's default level is kept in `infra/pi/thinking.ts` and rechecked on every Pi upgrade.

## A18 Bot History

History stores what a Bot thought, said and did as one table of complete messages, not Pi's event tree. Pi-specific data goes to `extra.pi`; tool call IDs are kept as given. Capture listens after Pi's own entry writer; Pi's JSONL stays Pi's resume source and the two are never synced both ways ([memory](architecture/memory.md)).

## A19 Composite objects and send source

Bot and Chat are complete service-layer objects, not actors. Bot state is `stop / idle / running` with activities. A Bot's message records its source `(historyId, toolCallId)`: the assistant call is saved first, then the send, with the source in the same transaction. The idempotency key uses the History row and call ID, because tool call IDs are not unique across a session. Old messages have no source.

## A20 Hono and visible layers

HTTP uses Hono with explicit routes; the code is `src/web` and `src/server` with `api / service / infra / shared` ([layout](architecture/layout.md)). **Why:** renaming folders does not fix cross-layer calls, so dispatch, prompts, file I/O, credentials and SSE moved with it. Errors are typed, not classified by message text. The Node adapter does not replace global `Request` / `Response`, which Pi uses in the same process. The build enforces the import rules.

## A21 Memory is chat history plus History

No long-term memory store. A Bot searches chats, then reads History by ID with `history.read` (summary or detail, JSON or Markdown, optionally to a file in its temp folder). It is reached through the `chat` gateway for discovery only; data comes from the Bot's Memory and Workspace, and no Bot ID or path can be passed. Detail omits `usage` and `extra`. Formatted strings go to the SDK as is, avoiding double JSON escaping.

## A22 Activity timeline

Bot info shows a two-sided timeline: chat messages left, time centre, History right. BotService merges the two sources within the owner's scope; chat items also need read access. Ordering is by time with a fixed tie-break and a cursor of time, type and ID, so pages neither skip nor repeat. Order is not causality; links come only from saved sources.

## A23 No History button on chat messages

The button was an unrequested expansion of the UI and was removed with its state. Sources and the timeline stay.

## A24 Pi 0.99.1

`pi-coding-agent` and `pi-ai` are pinned to 0.99.1. Existing sessions (JSONL v3), History and Codex accounts carry over. New `thinkingLevel` / `nestedCalls` go to `extra.pi`. ChatGPT login needs a stable device ID, stored per data directory in v8 rather than reusing a member ID. Pi now writes the session file at the first user message; Jarvy's recovery rules are unchanged. Pi's shrinkwrap pins `brace-expansion@5.0.9`, which `npm audit` flags; no override is applied until upstream updates.

## A25 Codemode without special handling

Pi's codemode is enabled in its default mode. `chat` behaves the same from a script and directly. Sends from inside a script have no History source rather than a guessed one. When Pi cancels a `bash` inside codemode it reports an error, so the turn is recorded as failed; this is upstream behaviour and left as is.

## A26 Message layout, composer, model auto-configuration

- Bubbles lost `white-space: pre-wrap` (which turned Markdown's newlines into blank lines); `remark-breaks` keeps single line breaks, and spacing is tightened in `jarvy.css`.
- A bare URL ends at the first CJK or full-width punctuation mark (`web/cjk-links.ts`): GFM ends autolinks only at whitespace, so Chinese text after a URL became part of it. Chinese letters inside a URL stay; links written as `[text](url)` are untouched.
- The composer grows with its content up to 130 px, then scrolls.
- Auto-configuration uses only the catalog bundled with the pinned SDK (offline and reproducible; new models arrive with Pi upgrades), never stores where a suggestion came from, and copies compat and thinking format only when the protocols match. compat is checked for shape and size only, since its fields change with Pi ([models](architecture/models.md)).

## A27 `jarvy on` / `jarvy off`

`on` sets up the account if needed, starts `run` detached with output appended to `jarvy.log`, and returns once the server listens. `run` writes `jarvy.pid` (PID, process start time on Linux, URL). `off` sends SIGTERM and waits up to 30 s, without SIGKILL, so shutdown is never cut short mid-write. A stale pid file (dead process or different start time) is removed. The data-directory lock remains the only mutual exclusion.

## A28 Model and thinking switches apply immediately

Supersedes A10's timing. A switch is serialised only with start, stop and other switches; a running turn uses the new model or level from its next request, because Pi reads them before every request and resolves keys when a request starts. If a switch fails mid-turn, the old credential is restored and the turn continues. Run snapshots hold the selection at claim time; History records the model actually used.

## A29 Settings and Bot info redesign

Settings and Bot info share one set of `--jv-*` tokens mapped from the theme. Settings: navigation on the left, providers grouped as custom API / subscription / API key. Bot info is a single page — identity, model, persona, 运行 — with the former "advanced" page folded into 运行; the activity timeline remains its own view.

## A30 Cookie name per data directory

Browsers scope cookies by host, not port, so two instances on one host logged each other out. The cookie is `jarvy_session_<first 10 hex of sha256(realpath(data dir))>`; its attributes are unchanged. Upgrading requires one new login.

## A31 Interrupted vs failed

The adapter maps Pi's result: the last assistant message `aborted`, or `error` while the run's `agent.signal` is aborted → interrupted; any other `error` → failed, shown as 「模型请求失败：<reason>」 (at most 300 characters). It uses Pi's public signal, not Jarvy's own flag or error text. History keeps Pi's original record.

## A32 Message IDs are `m<position>`

Message IDs are `m` plus the global message sequence (never reused), keeping the XML short; members, chats and attachments keep UUIDs. v9 rewrites existing IDs and references at startup. Old UUIDs in sessions and History stay as history; there is no mapping table, since no tool takes old IDs.

## A33 The Bot figure

Bots are drawn as a three.js block cat in one of six random colours (changeable in Bot info); uploaded avatars were removed (v10). State (body, paws, head) follows the Bot's status; mood (eyes) is set only by the Bot. Small avatars are PNG snapshots from one shared off-screen renderer; the floating, draggable cat in a DM is the only live canvas. Running Bots show three bouncing dots in lists. Mood is stored and shown; the `self.mood` tool, whose value enters the system prompt only when the session is created or compacted, is not built yet.

## A34 Attachment preview

Messages show image thumbnails and file cards. A thumbnail keeps the picture's proportions once it has loaded: as wide as the picture, up to the card's width, at most 320 px tall (260 px on phones), never enlarged; until then it has a fixed height. The viewer previews images, Markdown, text and static HTML (scripts, frames, external loads and event attributes removed, in a `sandbox=""` iframe with a deny-all CSP), with full-window mode and navigation between a message's files. The backend and page CSP are unchanged: SVG is read as text and shown as a `data:` URL.

Audio and video (webm, mp4, mov; mp3, wav, ogg — by type first, then extension) play in the browser's own `<video controls>` / `<audio controls>`, never autoplaying; the element streams from the attachment URL, nothing is read whole first, and the 1 MB preview limit does not apply. A file the browser cannot decode falls back to download. For seeking (and for Safari, which plays video only from partial responses), `GET /api/attachments/:id` answers a single `Range: bytes=…` with 206 (`bytes=-0` or a start past the end is 416; an end past the file is cut to its last byte; several ranges or a malformed header get the whole file), after the access check. It sends the file's own `Content-Type` only for a fixed list of media types — `video/webm`, `video/mp4`, `video/quicktime`, `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/webm`, `audio/mp4` — and `application/octet-stream` for everything else; `nosniff` and `Content-Disposition: attachment` stay.

## A35 Running HTML with scripts

HTML with scripts shows a notice (script count, external hosts) and runs only after confirmation, every time. `GET /api/attachments/:id/run` serves it with its own policy — `sandbox allow-scripts`, permissive `default-src`, no forms, framing by self only — and no `X-Frame-Options`; every other response keeps the strict policy. **Why an endpoint:** `srcdoc`, `blob:` and `data:` documents inherit the page CSP. The document is an opaque origin: no cookies, no readable API responses, mutations rejected. It can still reach the network.

## A36 `messages.ask`

A blocking question card: 1–6 options, multiple choice, free text, dismiss. The answer is stored on the question message and creates no new message, which would interrupt the waiting turn. A new message, cancel, stop or restart marks the question ignored and interrupts the turn; later answers get 409. While waiting, the Bot's activity is `asking`. No secrets input, forms or timeouts.

## A37 Channel groups, channels and threads

**Why:** one group chat per project limited concurrency and mixed everything together. Information is organised as channel group → channel (with a notice) → thread ([channels](architecture/channels.md)).

- Unchanged: one session per Bot (A03), transactional deliveries (A04), new deliveries interrupt (A05), Pi untouched.
- People and Bots are equal participants. In channels and threads only @-mentioned members get a message; @ comes from the text; names are unique.
- One read position per member per chat, shared by people and Bots; a Bot's delivered messages are not its unread.
- Threads are chats tied to a channel and a root message, with access inherited from the channel; following affects only unread.
- One DM per pair of members. Channel messages are flat rows; DMs keep bubbles and the floating cat.
- Supersedes A01's DM-only scope.

## A38 More for Bots

- **Subscribing** to a channel or thread delivers every new message there, each one interrupting. Subscriptions belong to the Bot and are listed in its Bot info.
- Bots may create channels, edit name, topic and group, add members, and manage groups; removing members and deleting stay with people. Supersedes A37's people-only rule.
- Bots can DM any member by name, including other Bots. The owner reads Bot-to-Bot DMs but cannot write in them.
- `messages.read` gains `around` and unread-only reading, and outputs names; `messages.search` can search every readable chat.

## A40 Timeouts and compaction

**Why:** at about 490k tokens a single request took longer than Pi's 300 s idle timeout, compaction (which reads the whole session) timed out too, and every turn failed. Pi's request timeout is set to 900 s (`httpIdleTimeoutMs`). Node's global undici dispatcher, which the Pi CLI configures but the SDK does not, also gets 900 s header and body timeouts (`infra/pi/http.ts`, mirroring Pi's `configureHttpDispatcher`; `undici` pinned to Pi's version). Compaction follows the model's window and Pi's own triggers, but keeps more room for its summary than Pi's 16k default (`compactionReserve`: never below that default, up to a quarter of a small window, 13% of a large one, at most 64k). Pi gives the summary 80% of that room, thinking included; with 16k a Bot thinking at `max` ran out before finishing a summary, every compaction failed, and the context filled until a turn had a single token left to answer with (10/13). The price is compacting up to about 50k tokens earlier. Compaction start, end and failures are logged. Risk: near a full window a single request may still exceed 900 s.

## A41 Delivery pipeline

Three layers ([delivery](architecture/delivery.md)):

- **Message sources** (`service/chat`) report events: messages, reactions, new notice or summary versions.
- **Routing and delivery** (`service/delivery`) decides recipients and reasons, maps kind × reason to `interrupt / queue / digest` through one policy table, and writes the inbox in the same transaction as the fact.
- **Handling** looks only at urgency. A Bot aborts and re-prompts, steers or wakes, or waits. A person's sidebar shows red counts, hint lines and the tab badge.

Further decisions:

- People and Bots are routed, prioritised and stored the same way.
- Policy: messages (DM, @, reply, subscription) interrupt; reactions and new notice / summary versions are queued, and the editor is not told. This supersedes A37's "attach once to the next batch".
- Storage holds no routing rules. `bot_pending` and `bot_notices` become one `inbox` table (v16). Deliveries fall in three categories — chat messages, chat activity, system notices — and system notices name no chat (A61).
- Unread stays state (read positions), not an event.
- **Person side** (in the style of Feishu): red count and preview for interrupts; a red 「[有人@我]」 prefix while an @ or reply is unread; queued events only as the hint line, cleared on opening the chat; channel rows on two lines; tab badge and 「(N)」 title counting interrupts only.
- **Mute** is a per-recipient override: DMs and subscriptions in a muted chat (a thread follows its channel) are queued instead of interrupting; @ and replies still interrupt. It applies to Bots too; only people have a way to set it so far.

## A42 Reactions toggle, and the tool says which way

Marking a message with an emoji is a switch: asking for a mark the actor already has takes it off, and asking to take off a mark it does not have puts it on (from the UI's reaction row, `messages.react`, and `PUT /messages/:id/reaction`). The tool result says which happened — `marked` / `unmarked` plus a short note — so a Bot can tell "I marked this" from "that mark came off", which is what the state marks in the prompt (「收到」「在办」「办好」) depend on. A39 still holds: one mark per person per emoji, and a mark is queued to the message's author. Restarting or editing a message does not touch marks.

- A reply quotes a message in the same chat and **counts as @-ing its author**.
- Reactions: eight quick emoji plus more, one per person per emoji. A reaction is delivered to the message's author as a queued notice: it wakes an idle Bot and is steered into a running turn, never interrupting. Each is told once; removing it first withdraws it.
- Pins are per member and put a chat first in its group.
- Deleting a Bot is a soft delete: it stops, its DMs, memberships, subscriptions, session and History go, its channel messages stay under 「名字（已删除）」, its name is free again, and its workspace is kept unless chosen otherwise.

## A43 `bots.list`

A read-only chat tool that lists every Bot with its run state, so a Bot can tell whether another one is busy, waiting for someone, stopped or failing before it hands work over or waits for a reply.

- Rows: `name`, `self`, `status` (`stop / idle / running`, the existing three; no separate "stopping"), and while running `activity` (`reasoning / texting / tool_calling / asking`) and `chats`, the chats of the messages the current run is handling. `error` is the latest run's public `bot_runs.error_code`, present only when that run failed. Self first, then by name; deleted Bots are not listed.
- Every Bot sees every Bot's name and state; the tool description says so, so it is not treated as private. The one filter is that chats the caller cannot read appear only as a count (`otherChats`), never by title.
- No connection, model, credential, run ID or context usage. There is no `owner` field: all Bots belong to the one person, and people see state in the UI.
- It offers no operations. Restricting who may act on which Bot is left to multi-user support.

## A44 Partial quotes

A person can quote a passage of a message, several per reply, each shown as a tag that jumps back to its source. Messages store quotes as structure; only delivery to a Bot turns them into text.

- **Storage**: a message carries `quotes`, each `{ source message, its sender, the quoted text }`, in a `message_quotes` table (schema v17); the source reference is cleared if that message goes, the text and sender stay. The content marks where each quote sits with `[[q1]]` … `[[qN]]`, by position.
- **The quoted text is a snapshot, not character offsets**: people select rendered text, which does not map reliably back to Markdown positions, and a snapshot still reads when the source is no longer visible.
- **Sending** (`POST /chats/:id/messages`, `quotes: [{ messageId, text }]`): at most 10; every marker matches one quote and every quote is marked; the source is in the same chat, or is the thread's root when sending in a thread, and readable by the sender; the text is part of the source, compared ignoring whitespace and Markdown markup. Anything else is a 400. A message without quotes is not checked for marks, so text that merely looks like `[[q1]]` stays text. Copies to the channel (`alsoToChannel`) keep the quotes. Being quoted does not notify the source's author (unlike a reply).
- **Interface**: on desktop, selecting text in a message offers 「复制」 and 「在回复中引用」; the composer shows each quote as a removable tag 「名字：开头…」 on its own line, and it belongs to the chat's draft. In a message the tag jumps to the source and highlights the passage, or the whole message when the passage cannot be found, or says the source is gone; a source in another chat (a thread reply quoted in a copy to the channel) opens where it is. Phones show and follow quotes but do not create them yet.
- **Delivery to a Bot**: each marker becomes a quote line `> 名字（m123）：片段` (without the ID when the source is gone); over 200 characters keep the first 120 and the last 60 around 「……」. The same expansion is used wherever a Bot reads messages (`messages.read`, batches). History and storage keep the structure. Sidebar digests show the passage in 「」.
- Not covered: Bots creating partial quotes, quoting across chats, quoting attachments, quotes inside quotes.

## A45 Interface languages; English toward the model

Jarvy is for people in any language. The interface comes in Chinese and English, more can be added, and everything the model reads from Jarvy itself is English.

- **Interface**: every user-facing string goes through `t(key, vars)` from `web/i18n/`, with one dictionary per language (`en`, `zh`) and no i18n library. English is the reference; a build check fails when a key is missing from any dictionary or a string with CJK characters is left in a component.
- **Choosing the language**: on first visit from the browser's languages (`zh*` gives Chinese, anything else English); 设置 → 通用 switches it (with the theme), and so does a small switch on the login page; the choice is remembered in this browser. Dates and numbers are formatted with `Intl` for that language; `<html lang>` follows it.
- **Server messages**: the server does not word the interface. A failure a person can meet is thrown with a stable snake_case `code` (and `params` for the values its sentence needs, e.g. `discovery_http` → `{ status }`); its message is English, for logs and the model. The API answers `{ error, code?, params? }`, a Bot's status carries `errorCode` / `errorParams`, and `web/errors.ts` words each code; a build check keeps that table and the server's codes in step, both ways. Without a code the interface shows the server's English for a 4xx and a generic sentence for a 5xx.
- **Data the server writes**: previews go out as structure (content and quotes) and the interface words them. A title the server stores is language-neutral — the first message's text or file name, quotes as "passage", `A · B` for a DM between two Bots, `""` for an untitled DM (v18 turned the old 「新对话」 placeholders into `""`). Titles that already exist stay as written. Nothing else the server writes is worded either: `POST /bots` needs a `name` (the interface offers the first free 「新 Bot」 / "New Bot", … in its language), and the provider catalog has no display groups (the interface groups by `authType`).
- **Toward the model, English**: the system prompt, tool descriptions and schemas, envelope notes and tool results are written in English. The prompt tells a Bot to answer in the language of the person it is talking to (in a chat with several people, the language the chat is held in). What people write — Bot personas, notices, summaries, messages — is never translated.
- **Migration**: in batches, each merged to main as soon as it is done, so other work never waits on a long-lived branch. New interface code uses `t()` from the first batch on.

## A46 Bot usage

Bot info gains 用量: token use and cost per model for one Bot, for today, 7 days, 30 days or all of it.

- No new capture: Pi's per-call `usage` (tokens and cost from the model's configured price) is already in History, and the page sums it on request. On the largest History so far a 30-day sum takes about 11 ms, well under the 200 ms at which a summary table would be worth a schema change.
- One row per provider and model: calls, input, output, cache read, cache write, cost; a total below when there is more than one model.
- A model none of whose calls had a price shows 「未配置价格」, never $0; the total's cost leaves such models out and says so.
- Days start at midnight in the browser's time zone; the client sends the start time.
- Per Bot only; a total across Bots is not covered.

## A47 The live turn

While a Bot runs, the page showing its DM acts the turn out: the cat moves with what it is doing, a dialogue beside it says the thinking, the model's own text and the messages, and opening it shows the steps so far. Until now only a status word (`reasoning`, `tool_calling`) and the activity history afterwards showed what a Bot was doing.

- **Kept in memory, per Bot**: the running turn only, dropped when it ends — what it did is in History. No database change, no extra log, no history of turns.
- **Structure only, worded by the interface**: the server sends step kinds, tool names, a file or the head of a command, output head and tail, and a chat as `{ id, type, title }` (a DM named after the other member). Sentences come from `t()` (A45), so 「在读 ThreadPane.tsx」 follows the interface language.
- **Nested calls**: a codemode script's `read` / `bash` calls carry `parentToolCallId`; they are kept and shown indented under the call that made them.
- **Bounded**: 300 steps (the oldest finished ones dropped, never a running one), the latest 4,000 characters of each thinking or text block, 1,200 characters at each end of an output, 300 for an input summary.
- **Its own SSE stream** (`GET /api/bots/:id/live`, owner only, connected while the DM is open): a snapshot of the turn so far first, then patches batched every 100 ms (a step whole, streamed text appended, a dropped step). A slow reader is disconnected and reconnects from a snapshot, as on `/events`. Not a broadcast: nobody else's page is woken.
- **Four looks** in the dialogue: a thought bubble for thinking, a frameless murmur in brackets for the model's own text (which nobody else sees) — both hold all of the step's text, up to 12 lines (6 on a phone), scrolling and following the newest words unless scrolled back; while the pointer is on the dialogue or it is scrolled back, the next step waits — a named speech box for a chat-tool message (with `→ #chat` when it went elsewhere), a pill for tools and for how the turn ended. A message sent elsewhere turns the cat; a question tilts its head — and is answered on its card in the transcript, not in the dialogue.
- **Facts drive the motion**: read and the looking chat tools hold a page, edits and commands type, compacting yawns, retrying fidgets, a failed step is dizzy and shakes, a turn over 20 s that completes is happy and stretches. The base mood is the stored one; `self.mood` is still to come.
- **After a turn** the 「done」 line stays 6 s and fades; a click on the cat within 10 minutes brings it back, otherwise it opens Bot info as before.
- **The prototype stays**: `?npc=demo` plays a scripted turn and shows the toolbar (replay, base mood, one button per state); it needs no server and does the README's pictures.


## A48 The agent Bot

The Bot created at setup (Jarvy by default) is the owner's agent: it helps a new owner get started and helps run Jarvy itself — building and adjusting the Bot team, their models, usage, and clearing things away.

- **Which Bot**: the setup Bot always has the same id, and that id is the agent; nothing is assigned or stored. It can be renamed, stopped and started like any Bot, but not deleted (`agent_undeletable`). If it is missing at startup (deleted before this version), it is created again with that id: named Jarvy (Jarvy 2, 3… if the name is taken), no persona, no model.
- **What only it can do**: its `chat` gateway lists more tools; other Bots don't see them, and a call from them is an unknown tool.
  - `bots.create` (name, description, persona, model, thinking) and `bots.update` (the same fields, for any Bot, itself included); `bots.start` and `bots.stop` (not itself); `bots.usage` (A46); `models.list` (connected models and their thinking levels, never credentials).
  - Adding connections, keys and logins stays with the owner in Settings until a way to enter secrets that never passes through a chat exists.
  - Deleting: `bots.delete` (not itself), `chats.delete` (a channel it is in), `chats.removeMembers`, `sections.delete`. Each first posts a confirmation card in a chat the owner is in: the agent writes the question and the two button labels in the owner's language, and the deletion runs only if the owner picks the confirming one; declining or dismissing the card changes nothing. The card is a step of the tool, not a rule in the prompt. A confirmed deletion runs as the owner, so the channel layer's "only people remove members or delete" stays as it is.
- **Bots are told what changed**: when the agent changes another Bot's name, description, persona, model or thinking, or starts or stops it, that Bot is told with its next batch (a `digest` delivery: it is not woken for it), as `<change>` entries with the new value; a persona isn't repeated, it is already in the prompt. Since A61 these are system notices: no DM between the agent and the Bot is opened for them, and the note says to ask the agent with `messages.send`. The welcome is one too: no chat is named, and the agent writes to the owner itself.
- **Prompts**: `bots.list` marks the agent (`agent: true`) and says what to ask it for; its own prompt gains a short section on its role (guide the owner, build their Bot team, confirm before deleting). All of it is English (A45).
- **Onboarding**: the first time the agent has a model — normally when the owner picks one in its DM after setup — an `onboard` delivery goes to the agent in that DM, and its turn welcomes the owner and asks what they want to get done (a software project, writing, research, …). The browser sends its interface language with the model choice, and the request asks for the welcome in that language. It happens once: a setting records it, and on upgrade an agent that already has a model counts as onboarded.
- **Interface**: the agent's DM is always on top of the DM list; its Bot info has a short section on what it does for the owner, and its row menu has no delete. Its avatars wear a crown.
- **Storage (v19)**: a `settings(key, value)` table (first key: when the agent was onboarded); `inbox.kind` gains `onboard` and `change`, so the table is rebuilt with its rows.

Why: the setup Bot already has a fixed id that survives renaming, and keeping it undeletable leaves nothing to keep in sync. A model can skip a rule in its prompt but not a step in its tool, so confirmation lives in the tools. Connections stay out until keys never have to pass through a chat.

## A49 Pi 1.2.0 and the online model catalog

- `pi-coding-agent` and `pi-ai` are pinned to 1.2.0 (supersedes A24's version). Sessions (JSONL v3) carry over both ways; History, credentials and Codex accounts are unchanged. Pi now brings `pi-agent-core` (its agent loop), which stays behind `infra/pi` like the rest. Pi no longer ships a shrinkwrap and pins `brace-expansion` 5.0.12 itself; `npm audit` is clean.
- Auto-configuration and the provider list read the model catalog with pi.dev's overlay (supersedes A26's bundled-only catalog). Jarvy fetches pi.dev's catalog at most every 4 hours (on a timer and when a connection is opened since A62), keeps it in the data directory, and falls back to it and to the bundled catalog when offline; `PI_OFFLINE=1` turns the fetch off. Pi's own overlay only refreshes providers that have a credential, so the catalog fetches the whole list itself, in the same shape. Entries newer than the SDK can carry fields it ignores, so the overlay brings models released between upgrades, not new request features.
- Pi renamed the Azure provider from `azure-openai-responses` to `azure`. Saved connections are not migrated: an Azure connection made before has to be created again.
- Codemode's own description is shorter and its errors say how to recover; Jarvy's tools and prompts are unchanged.

## A50 Work environments

A work environment is where a Bot's file and command tools (`bash`, `read`, `write`, `edit`) run; the Bot itself — its session, model calls and chat tools — always runs in Jarvy.

- **Kinds**: a Bot's sandbox (a Docker container Jarvy creates with the Bot; kind `computer` in the code), the owner's computer (the machine running Jarvy), later SSH hosts and VMs. The interface calls them 工作环境 / work environments, and the two defaults 沙箱 / Sandbox and 你的电脑 / Your computer.
- **Who may use what**: environments belong to people. A Bot may use its sandbox, its default and what its owner granted it. A grant is given once and lasts until revoked; there is no confirmation per switch. Only the owner grants, in Bot info, not the agent Bot; the owner's computer and SSH machines (A57) can be granted, and Bots ask for a machine on a card (A57).
- **Two words**: the workspace is the Bot's own folder, which it never shares and which tells people where its private, lasting files are; a work environment is where its tools run. A Bot's default is one of two kinds, its sandbox, which Jarvy makes and manages (a container, later a VM), or the owner's computer; external environments the owner adds in Settings, so far SSH hosts, are temporary places it is granted and switches to, never a default. The owner may also grant their computer to a Bot whose default is its sandbox.
- **The current environment**: each Bot has one, like a working directory one level up. A chat tool switches it (`environments.list`, `environments.switch`; `environments.request` comes with the card); it stays until switched back, and the tools' directory becomes that environment's directory. Commands already running finish where they started. Each batch ends with where the Bot is now, while the system prompt describes its default and stays the same, so a switch keeps the prompt cache. A switch the Bot makes is a tool call in its History; what the owner changes is a delivery (A41) of kind `change`, a system notice about no chat (A61): a move of a running Bot (reason `move`) interrupts its turn like an @, and a Bot not running, or a change of access alone (reason `owner`), hears of it with its next batch.
- **Layering**: `shared/environment.ts` is Jarvy's own interface (run a command with streamed output, read, read the first bytes, write, make a directory, check a path, close). `infra/env/` is the only code that uses pi-env and the Pi Durable pieces it is built on; `infra/pi/` gives Pi's tools operations on the interface and keeps their paths inside the environment. Who may use what, switching and attachments live in the service layer. `check-boundaries` enforces the split, as for Pi in `infra/pi/` and SQLite in `infra/storage/`.
- **Execution**: on the owner's computer, Pi Durable's `NodeExecutionEnv`; elsewhere pi-env's daemon, started inside the target (`docker exec -i`, `ssh`), whose results match `NodeExecutionEnv` running there. One connection per Bot and environment carries many requests at once; Jarvy closes every environment on shutdown. Only the owner's computer receives the host's environment variables. A dropped connection stops running foreground commands; background processes a Bot started survive.
- **A Bot's directory** (`bots/<id>/`): its session files and History stay on the machine running Jarvy and never enter an environment. Its `workspace/` is the Bot's directory on the owner's computer and is mounted into its sandbox as `/workspace`, where it runs with the owner's user and group ids.
- **A Bot's sandbox**: a container from an image Jarvy builds locally from the Dockerfile it ships (Playwright's Ubuntu image with its browsers and package, git, Python, build tools, CJK fonts; one image for every Bot, stored once, so it holds what most Bots need and Bots install the rest), run as a non-root user with passwordless sudo inside it, so the Bot can install software, whose home is the mounted workspace, so its settings stay with it, and with the daemon mounted read-only. Created with the Bot and kept running until the owner stops it, since stopping, releasing and resetting are destructive and the owner's to do, each asking first; a stopped one starts again with the next tool call; resettable (what was installed goes, `/workspace` stays); deleting the Bot removes the container and asks, as before, whether to keep the workspace. Containers outlive a Jarvy restart. Without Docker, new Bots get the owner's computer. Existing Bots keep the owner's computer; the owner can move any Bot between the two in Bot info.
- **Attachments belong to the backend**: messages carry an attachment's id, name, type and size, not a host path. `files.get` puts one into the current environment and returns its path; `files.view` gives an image or text to the model directly; sending takes the file from the current environment.
- **Storage (v20)**: `environments` (owner, kind, name, connection, directory) and `environment_grants`; a Bot gains its own and its current environment.
- **Postponed**: isolation strength (the docker group is root-equivalent), VMs, quotas. SSH machines came with A57.

Why: Bots shared the owner's identity and every file it can reach, and interfered with each other through packages, ports and disk; work on other machines needs the same tools there. The trial ran a Bot's tools in a container over one pi-env connection: 2 ms a command against 47 ms for a fresh `docker exec`, twenty commands at once in 1.05 s, ~600 MB/s for large files with small requests still answered in milliseconds. Pi's tools already take pluggable operations, and with Pi 1.2.0 (A49) pi-env adds 18 MB. Built in steps; step 1 puts every Bot's tools on the interface, on the owner's computer.

## A51 HTTPS beyond this machine

Jarvy serves HTTPS itself whenever it listens beyond this machine. Plain HTTP from another machine is an opt-in that the interface warns about. It is the first step of the secrets work: a value typed into a card must not cross the LAN in plain text, and neither should the login password, model API keys and conversations, which did so far.

- **Certificates**: Jarvy makes its own root the first time (ECDSA P-256, ten years, may only sign server certificates). The root signs a server certificate for 397 days, the most Apple and browsers accept. That certificate covers this machine's name and `<name>.local`, `localhost`, the loopback addresses, the host given and the LAN interfaces' addresses, leaving out containers, VMs and proxy tunnels. It is signed again at start when it nears its end or misses an address, so devices trust the root once. Written with Node's crypto, so there is no new dependency. The keys are 0600 files in the data directory; they will be encrypted with the secrets' master key when that exists.
- **One port, both protocols**: the first byte of a connection tells a TLS handshake from plain HTTP, so addresses and bookmarks keep their port. The HTTPS session cookie is `Secure` and named apart from the plain one, which browsers would otherwise refuse to set.
- **Plain HTTP**:
  - From this machine, by any of its addresses, it is always served. Browsers count `localhost` as a secure context, the upgrade scripts and `jarvy on` talk to it there, and tools here that use the LAN address keep working.
  - From another machine it gets a 308 to HTTPS, unless the owner turns on "Allow HTTP access" in Settings → Network (stored as the `allow_http` setting, effective at once).
- **Warning**: any page that is not a secure context shows a lasting banner above the login page and the app, with a link to HTTPS. TLS added by a reverse proxy counts as secure.
- **Trust**: Settings → Network (its own tab) lists the HTTPS addresses, offers the root (also public at `/api/connection/root.crt`) with its SHA-256 fingerprint, and gives steps for Mac, Windows, iPhone and iPad (install the profile, then turn on full trust) and Android. A device without it gets the browser's warning once.
- **Only on this machine** (the default `127.0.0.1`): nothing changes; no certificate is made.

Why: encrypting only a secret inside the page protects nothing against someone who can change the page, and browsers give plain-HTTP LAN pages no WebCrypto, clipboard or notifications. A reverse proxy stays possible, but most owners won't set one up, so the default has to be safe.

## A52 Secrets

Secrets are the owner's assets, like model connections and environments: kept in Settings, granted to Bots, never shown in plain text again, and used without their values reaching the model. They are built in steps; this records what is in place.

- **Kinds**: *values*, such as tokens and passwords, named `UPPER_SNAKE` so Bots can refer to them; and *SSH keys*, one per Bot (the kind exists in the schema; keys come later).
- **Master key**: a random 256-bit key in a file readable only by the owner, in the user's config directory (`$XDG_CONFIG_HOME/jarvy` or `~/.config/jarvy`, `%APPDATA%\jarvy` on Windows), named by the installation. It sits outside the data directory, so a copy or backup of the database or the data directory doesn't carry it, and Settings shows where it is so it can be backed up. It is made the first time something is sealed. A system keychain can hold it later; the machines Jarvy runs on today have none to rely on.
- **Sealing**: AES-256-GCM, a fresh IV per value, bound to where the value is stored (`secret:<id>`, `credential:<connection id>`, `tls:<key name>`), so a sealed value copied to another row doesn't open. People and logs see an 8-hex-digit HMAC fingerprint instead of a hash anyone could test guesses against.
- **What is sealed**: secret values; model credentials (`provider_credentials`, which migration v21 seals in place); and the private keys of Jarvy's TLS certificates (A51), sealed and the plain files removed at the next start.
- **Storage (v21)**: `secrets` (owner, name, kind, the Bot an SSH key belongs to, description, sealed value, fingerprint, times), `secret_grants` (secret, Bot, `always` or `once` with its run, who granted it) and `secret_uses` (secret, its name, Bot, time, how — `command` or `ssh_sign` — environment, History id and tool call, and what ran with placeholders). Uses outlive the secret. Deleting a Bot removes its grants.
- **Settings → Secrets**: add a secret (the value is masked unless shown), change its description or replace its value (never shown again), choose which Bots can use it, see its recent uses, delete it after confirming in place. A value that doesn't open under this installation's key is marked and has to be entered again; so do model credentials, whose connection then reports it.
- **Asking**: `secrets.request {chatId, name, purpose}` posts a card in a chat with the owner and waits, as `messages.ask` does (A36). The owner enters the value on the card (masked unless shown) or uses the saved one, and allows it until revoked or only for the Bot's current run, or declines. The value goes to its own endpoint, never into a message, and the secret is saved and granted before the card settles. The card warns when the page isn't on HTTPS and when a value is short. `messages.ask` points to it instead.
- **Using**: `secrets.list` gives a Bot the names and descriptions of the secrets granted to it, never values. The model writes `{{secret:NAME}}` in a `bash` command; before it runs, Jarvy turns each into `${JARVY_SECRET_NAME}`, quoted for where it stands, and passes the value in that command's environment only, in every environment. A quoted heredoc would keep the placeholder literal, so it is refused; `write` and `edit` content is never filled in; a name without a grant fails the call, naming `secrets.list`. Each use is recorded with the command as written.
- **Masking**: every value the owner keeps, and its JSON-escaped, URL-encoded, XML-escaped and base64 forms (three alignments, standard and URL-safe), is replaced with its placeholder in tool results before Pi keeps them (nested codemode included), in command output as it streams, in every batch a Bot receives and in the arguments of its Jarvy tools. A person's own stored message is unchanged; images can't be masked.
- **Prompt**: a "## Secrets" section: never ask for passwords, tokens or keys in the chat; `secrets.list`; placeholders in bash, handed over through a program's environment where possible; `secrets.request` for a missing one.
- **Limits**: a Bot whose tools run on the owner's computer shares the owner's user and could read the key file; only sandboxed Bots are kept out. Losing the key file loses the secrets and model credentials, not the rest of the data. Masking stops accidents, not a Bot that transforms a value on purpose; an expanded value shows in the arguments of programs a command starts.

Why: Bots need tokens and keys for real work (git hosts, registries, APIs). Pasting them into chat put them in messages, sessions, History, logs and every later model call, and the model API keys lay in the database in plain text.

## A53 Unread in send results

`messages.send` and `messages.ask` tell the Bot when the chat it just wrote to has messages it hasn't read (A53). Only @-mentions, replies, DMs and subscriptions are delivered (A37, A41); everything else in a channel or thread the Bot sees only if it reads, so it could answer past what had just been said there.

- **What counts**: the chat's unread count for the Bot (A37): others' messages after its read position that were not delivered to it. Delivered messages arrive in a batch anyway, so they are not counted twice.
- **Taken before sending**: posting moves the sender's read position to its own message, so the count is taken just before; afterwards `unread=true` would find nothing. The note therefore points to `messages.read` with `after`, the read position from before.
- **Where**: the result gets `unread` (the count) and that note, only when the count is above zero. No message text, so results stay small. `messages.ask` adds what came in while the card waited.
- **Threads count themselves**: a thread reply reports the thread, not its channel; the channel's unread comes with the next batch's tail.
- **A reminder, not a block**: sending still succeeds. Bots often send twice in a row (progress, then the result), and a refusal would only add a read before every resend.

Why: the Bot learns about the gap at the moment it acts in that chat, at the cost of one count per send.

## A54 Context usage from the model

Bot info's context figure is the size the model itself reported with its latest reply (`infra/pi/context.ts`, the `usage` of the last assistant message on the session's current branch), not Pi's `getContextUsage()`, which estimates characters divided by four and reads about half the real size for Chinese, code and JSON.

- **Unknown, not zero**: before the first reply, and after a compaction until the model reports again, the figure is unknown; it is never shown as 0 %.
- **Stale**: Pi records a `context_edit` when it drops a failed request before retrying or compacting. After that the figure stays from the last successful reply, with a warning icon in Bot info that explains on hover or tap.
- **The window** still comes from `getContextUsage()`; only the size is reported usage.
- **Errors and aborts** are skipped when looking for a reply to report, so an error reply's usage never becomes the figure.

## A55 Skills for the agent Bot

Jarvy ships skills: guides for a kind of work the agent Bot (A48) helps the owner with. The first, `dev-team`, is how to run software development with a team of Bots in Jarvy — forming the team, splitting roles, organizing channels, using threads and keeping channel notices.

- **Files**: one folder per skill under the package's `skills/`, each with a `SKILL.md` that starts with `name` (lowercase words joined by hyphens, the folder's name) and `description` between `---` markers. A file without both is skipped with a warning (`infra/files/skills.ts`).
- **In the workspace**: each time the agent Bot starts, Jarvy writes them into its workspace as `skills/<name>/SKILL.md`, replacing what is there, so an upgrade brings the new text and edits don't last. Its tools read them there in any work environment, the sandbox included, where the workspace is the Bot's home.
- **In the prompt**: the agent Bot's prompt lists each skill's name, description and file, and says to read the file before such work and to propose plans from it for the owner to confirm. The text itself is read only when the work calls for it.
- **Not Pi's skills**: Pi's skill discovery and its prompt section stay off (`noSkills`, A49); nothing on the machine is picked up. Other Bots have no skills; the owner can't add any yet.

Why: a guide that is read only when needed keeps the prompt short, and a file in the workspace reaches the Bot wherever its tools run, without a tool of its own. Plans stay with the owner because a team and its channels are theirs to decide.

## A56 A changed system prompt is told, not swapped in

Changing a Bot's name, description or persona, its skills or its workspace changes its system prompt. A system prompt that changes mid-session makes the model read the whole conversation again at full price, since providers cache a prompt from its start. So a running session keeps the system prompt it has and is told what changed.

- **Parts**: the prompt is built in named parts (`service/bot/prompt.ts`), so a change can say where it is.
- **Told once**: before each batch the session compares the live prompt with the newest version the model knows. A difference goes into the batch as `instructions_changed`: the changed parts and, per part, the changed lines with two lines of context, at most 40 lines; a longer change is told as the changed parts' new text. At most 8000 characters either way. The next change is measured from what was told.
- **Taken up**: the live prompt goes out when a session starts (a new session, a restart of Jarvy), after the model or connection changes, and after a compaction. In each case the provider has nothing cached for this conversation anyway.
- **Not by time**: a provider's cache also expires after minutes without requests, but providers don't report when, so idle time doesn't count.
- **In memory**: what the model knows is kept in memory only. After a restart the session starts from the live prompt.
- **Not covered**: tool definitions and the skill files themselves are outside the prompt text; changes to them are not handled here.

Why: a persona edit should cost a few lines in the next batch, not a full-price read of the conversation, and the model should know the change at once instead of finding it in an unannounced new prompt.

## A57 SSH machines

The owner adds machines over SSH as work environments (A50) and grants each to the Bots that may switch to it. Jarvy logs in with a key it makes for each machine; Bots never see a password or key.

- **One key per machine**: an ed25519 key pair made with `ssh-keygen` when the machine is added; its public half goes into the user's `~/.ssh/authorized_keys` with the comment `jarvy-<machine id>`, and its private half is sealed under the master key (A52). Per machine, so deleting one takes away exactly that access and nothing else.
- **The password once**: the owner types the login password in Settings or on a Bot's card; it installs the key over one `ssh` login (through an askpass helper reading it from that process's environment) and is dropped. The machine is saved only after a login with the key succeeds; if a later step fails, the key is taken off again. Machines that refuse passwords wait for a later way in (pasting a key, an existing key).
- **Host keys**: scanned before the password is asked for and shown as fingerprints to check against the machine; the accepted keys are kept with the machine and checked strictly, in Jarvy's own known-hosts file under a per-machine alias. A changed key is refused until the owner checks it in Settings and accepts the new one. The owner's `~/.ssh/config` and `known_hosts` are not read, so a machine is reached exactly as it was added.
- **Asking on a card**: `environments.request {chatId, host, user, port, directory, name, purpose}` scans the host and posts a card in a chat with a person; the owner checks the fingerprint and types the password, or declines. The tool waits like `messages.ask` (A36) and returns the machine's id to switch to. The password goes to its own endpoint, never into a message. A machine already added needs only Allow; one the Bot may already use returns at once. `secrets.request` no longer names machine logins; the Work environment section names `environments.request`.
- **Working there**: a switch connects first and checks the start directory, so a Bot that can't get there stays where it was. Files Jarvy writes for the Bot (long outputs, chat files) go in `~/.cache/jarvy/<bot>/` on the machine. Linux and macOS.
- **Deleting**: Jarvy logs in with the key and removes its line first; an unreachable machine can be deleted anyway, leaving the line for the owner. Bots working there go back to their default and are told (A41).
- **Storage (v22)**: `environments.kind` gains `ssh`; `key` holds the sealed private key and `host_keys` the accepted keys and fingerprints.
- **Description (v27)**: the owner may write a few lines about a machine (what it is for, what is installed, what to watch out for). Bots read it in `environments.list`, not in every batch, so it costs nothing until a Bot looks for a machine. A Bot's card for a new machine doesn't ask for one; the owner adds it in Settings.
- **Not yet**: an SSH machine as a default, file copy between environments, port forwarding, machine templates, a key the owner pastes, hosts from `~/.ssh/config`, Windows, and a separate record of connections beyond the tool calls in History.

Why: work often lives on other machines — a server, a lab box, a NAS — and the owner shouldn't hand a Bot a password or put keys in its reach. A key made per machine and installed with one typed password gives Bots that access with nothing secret in the chat or the model's context, and lets the owner take it back cleanly.

## A58 Scheduled tasks

A Bot can have scheduled tasks: work it does once at a time or on a schedule, such as reading the news every morning, going through mail or summing up the week. The owner makes them for a Bot in Bot info; a Bot makes them for itself with the tasks tools. Either can see, change, pause, resume and delete all of a Bot's tasks; no Bot makes tasks for another.

- **A task**: a name, an instruction (what to do each time, in full) and a schedule, plus its state: `active`, `paused` or `done` (a one-off that ran). Deleting keeps the row, marked deleted, out of every list. A task is not tied to a chat: a due task is a system notice to its Bot (A61; before, it was told in the Bot's DM with its owner), and where the Bot reports is up to its instruction.
- **Schedules**, in the machine's local time: once at a time; every N minutes, 5 at the least, counted from when the task was made or its interval changed (renaming it, pausing and resuming or a restart keep the rhythm); daily at a time; weekly on a weekday at a time. Wall-clock times are worked out afresh each time, so 09:00 stays 09:00 across daylight saving. The next run is always strictly after now, so a run that is due is never given back as the next one. No cron expressions.
- **Due is a delivery**: the scheduler writes an inbox row of kind `task` (reason `schedule`, urgency `queue`) and moves the task to its next time in one transaction, then wakes the Bot as any delivery does (A41). A crash neither loses a run nor repeats it.
- **Never mid-turn**: a task is not steered into a running turn like a reaction or a note (A39). It waits for the turn to end and opens a turn of its own, or rides with the next batch, as `<tasks>` with each task's id, name, schedule, due time and instruction.
- **Missed runs are skipped**: at start, tasks whose time passed while the server was not running move on to their next time after now; a one-off already past is done without running. Nothing is made up.
- **Timer**: one timer sleeps until the soonest task, at most a minute, so a changed clock is noticed.
- **Storage (v23)**: `tasks` (an interval keeps the time it counts from in `schedule_at`); `inbox.kind` gains `task`.
- **Prompt**: one line in the Rules part (its Chat section) says the tasks tools exist and that a due task comes as a `<task>`.
- **Bot info**: a "Scheduled tasks" section laid out like an alarm list: each row shows the schedule and the next run (or off / done) with an on/off switch beside it, and opens the task's details, where it is changed, saved or deleted. The list reloads when the Bot starts or ends a turn. Giving a one-off that ran a new time turns it back on.

Why: Bots were only ever woken by someone writing to them; recurring work needed a person to ask each time. Making "due" an ordinary delivery reuses the runtime, the inbox, History and the activity timeline as they are.

## A59 SSH logins: the key or the password

A57 reached every machine with a key Jarvy installs with a password typed once. Some machines take only one of the two: a VM with `PubkeyAuthentication no`, a server with passwords turned off. Either is now enough. This amends A57's "the password is not kept" and "not yet: a key the owner pastes".

- **Password fallback**: the owner's password installs Jarvy's key as before. When the machine then refuses that key, the password is kept, sealed under the master key (`environments.password`), and used to log in; the key stays installed. A machine is reached with its key whenever it can be: Check fingerprint and 切换为密钥登录 try the key and drop the password once it works. 更新密码 checks a new password with a login first.
- **Key the owner adds**: instead of the password, the owner asks for Jarvy's public line (a fresh key per machine, kept in memory for an hour), adds it to the machine and has Jarvy verify it. Settings and a Bot's request card both offer it.
- **No Pi change**: pi-env always passes `BatchMode=yes`; a password login runs through a wrapper `ssh` that puts its own options first (ssh keeps the first value), with an askpass helper reading an owner-only file that exists only while the connection is open.
- **Errors apart**: `ssh_auth_failed` (wrong password), `ssh_password_refused` (the machine takes no passwords, read from `Permission denied (…)`), `ssh_key_refused` (Jarvy's key wasn't accepted), `ssh_key_expired` (the shown key is no longer kept).
- **Public key shown**: each machine's details show Jarvy's public line with a copy button, read back from the sealed private key, so nothing new is stored for it.
- **Storage (v24)**: one column, `environments.password`; no rows rewritten.

Why: a machine Jarvy can't log into with a key couldn't be added at all, nor one that takes no passwords. Keeping the password only when the key can't be used keeps it the exception, sealed like the key, and never seen by Bots; letting the owner add the key themselves covers machines where typing a password is not an option.

## A60 Long and folded messages

Bots sometimes write a lot into a chat — long logs, many steps in a row — and push the conversation out of view. Deleting loses what was said and breaks quotes, threads and what a Bot remembers, so messages are folded instead, the way Slack and Lark cut long messages and GitHub hides a comment.

- **Long text**: in the interface, a message's text past 12 lines shows its start, fading out, with 「展开全文」 (and 「收起」 once open). Two lines of slack, so 13 lines are not cut to hide one. Only the text is cut, never files or question cards. Nothing is stored.
- **Folding**: 「折叠成一行」 in a message's hover actions folds any message, in channels, threads and DMs. A folded message is one muted line with the start of its text and a quiet 「已折叠」 after it, no buttons. The same place in the hover actions then reads 「取消折叠」; that is the only way back, so folding is a plain switch. A message just unfolded shows its text whole, not cut to 12 lines again, until the page reloads. Folding one message at a time; no batch folding.
- **Interface only**: folding changes nothing for Bots. Their tools and batches read the message as before, without the folded state, and nobody is told. The owner is the only person, so the state is the message's (`messages.folded_at`, v25), not per member.
- **API**: `PUT /messages/:id/fold {folded}` returns the message; the change is announced like a reaction, so other tabs reload it.

Why: folding keeps everything — content, quotes, threads, a Bot's context — and can be undone, while it takes the noise out of view.

## A61 Three categories of delivery; system notices name no chat

A41 put every delivery in one inbox, but each row needed a chat. Half of what is delivered has none — the agent's welcome, a change to a Bot's settings or where it works, a due task — so each borrowed a DM, and a change the agent made opened a DM between it and the Bot that nobody wrote in. Inbox SQL was in five repositories, `detail` meant something different for each kind, and only chat sources went through route → policy; the others set their urgency in business code.

- **Categories**: `message` (a chat message: chat and message), `activity` (a reaction or a new notice / summary version: a chat, and for a reaction the marked message), `system` (a notice to one member: neither chat nor message). The recipient of a system notice can be a person or a Bot; so far only Bots get them, and notices to people are a later requirement.
- **One way in**: `service/delivery` has each kind's category and payload, and the policy table its urgency for each reason. Chat sources plan from a route as before; system sources name the recipient and reason through `Deliveries.notify`. A running Bot moved by the owner is its own reason, `move` (interrupt); other changes of where it works are `owner` (digest). No business code sets an urgency.
- **One repository**: all inbox SQL is in `InboxRepository` — writing, claiming, telling, withdrawing, the sidebar's state. A message and its deliveries are still written in one transaction.
- **No borrowed chats**: nothing opens or creates a DM to carry a notice. In a Bot's batch, `<change>` and `<onboard>` lose their `chat` attribute; the agent's note says to ask it with `messages.send` to its name, and the welcome says to write to the owner the same way, so the DM is made when the Bot first writes.
- **Storage (v26)**: `inbox.category`, with CHECKs that the chat categories have a chat, messages a message, and system rows neither; `kind` is checked in code, so a new kind needs no rebuild; `detail` becomes `payload`, JSON by kind (`{emoji}`, `{version}`, `{language}`, `{what, value}`, `{task, due}`). Existing rows are kept; system rows drop the DM they borrowed.

Why: a notice about no chat should not need one, and the fields a row must have depend on what it is. With one entry point and one repository, adding a kind is a category, a payload, a policy row and its rendering, not seven places and a table rebuild. This amends A41, A48, A50 and A58.

## A62 Resetting a connection's models to the catalog

A model saved under a connection is a snapshot of its catalog entry. When the catalog moved on — a new model, new prices, another protocol — nothing reached a connection already set up, and the only way back was to delete its models one by one and add them again; the catalog itself was only checked when someone opened the provider list. A model taken from pi.dev's newer entries also lost its address: Kimi Coding there is `openai-completions` at `…/coding/v1`, Pi bundles `anthropic-messages` at `…/coding`, and a request with the new protocol at the bundled address failed with 404.

- **Reset**: a built-in connection's models can be reset to the catalog. After checking pi.dev at once, it says how many models will be reset and which will be removed, naming the Bots that use them; on confirmation, in one transaction, the connection's address and protocol go back to the provider's, each saved model the catalog has is set to its entry (protocol, address, limits, thinking levels, prices, capabilities, name), and the others are removed. Kept: the key or login, the connection's name, each model's ID and request headers — so Bots on a reset model carry on, and Bots on a removed one wait for another model, as a new Bot does. Models the catalog offers that weren't saved are listed unticked, as before. A custom connection has no catalog to reset to.
- **A model keeps its address**: a model saved from the catalog stores the address its entry gives; requests go to the connection's own address first, then the model's, then Pi's bundled one. Changing a model's protocol by hand drops it.
- **Compat comes from the catalog entry**: what a saved model leaves out, its compat flags first, is read at run time from the catalog entry with its ID and protocol, pi.dev's newer one before Pi's bundled one. Saving only the protocol and address had sent K3.1, which only pi.dev lists, as plain OpenAI (`developer` role, `max_completion_tokens`, `store`), which Kimi refuses.
- **The catalog is checked on time**: every 4 hours while the server runs, and when a connection is opened if a check is due, besides at start (amends A49, where it was only checked at start and when the provider list was read).
- No database change: model configuration is JSON.

Why: a connection should be able to follow the catalog without losing its login, and a model from the catalog should work as the catalog describes it.

## A63 The HTTP contract, written once

The web and the server are separate programs joined by HTTP, and what crosses it was written twice: the server's `api/views` assembled a chat, a message or a Bot by its own idea, and `web/api.ts` declared the same shapes again by hand. Of the web's 38 types, 28 shared a name with a server type; 14 were copies and 14 had already drifted (the web's environment kinds lacked `ssh`, its chat said `botId: string` where the server sends null for channels, its task schedule took no `since`). Nothing tied the two, so a changed field showed up only as a broken page.

- **`src/contract/`**: the types the server sends and the web reads — chats, messages, members, Bots and their run state, models and connections, environments, tasks, secrets, the connection info — and the request shapes that differ from them (`ModelInput` with header updates, `ScheduleInput` without `since`). Plain types and constants, by area.
- **Imports**: the contract imports only itself, no package, Node or browser module. Every server layer may import it, as it imports `shared`; the web imports only `src/web` and `src/contract`. `check-boundaries` enforces both.
- **Server types stay the server's**: where the server holds more or other than it sends (a chat with its owner, a message with its sender's identity, a stored Bot with its workspace), its type stays in `shared/`, and `api/views` (or the service that builds a view) is typed to return the contract's. A field changed on one side fails to compile on the other.
- **No forwarding**: moved types are imported from the contract where they are used; `shared/` and `web/api.ts` do not re-export them.
- **Rules both sides apply**: the @ rule (`contract/mentions.ts`) is one function; the server takes who is mentioned from it, the web highlights and warns with it. Failure codes are one union (`ErrorCode`, `contract/errors.ts`): the server's error classes take only those, and the web's wording table is a `Record<ErrorCode, Key>`, so a code thrown without wording, or worded without being listed, fails to compile; `check-i18n` keeps only what types can't see, a code no longer used.
- The contract is the HTTP boundary written down, not a layer: the call path stays web → api → service → infra.

Why: one definition of what crosses HTTP, checked on both sides, so the web and the server cannot drift apart unnoticed.

## A64 Each Bot tool registered once

The `chat` gateway's 33 tools (43 for the agent Bot) were dispatched four ways: a switch of some thirty cases in `tools.ts`, a `ChatTools` class, an `AgentTools` class with its own switch, and a `callTask` function. Descriptions and parameters lived in schema files apart from the code, so a tool was added in two or three places, and arguments reached handlers through casts the parameters didn't check. The check that a person can answer a card was written three times.

- **One entry per tool** (`service/bot/tools/`): `tool(name, description, parameters, handler)`. The handler's arguments are typed from the parameters (TypeBox `Static`), which the gateway checks first; no casts.
- **By area**: `history`, `chats`, `messages`, `files`, `environments`, `secrets`, `tasks`, `agent`; a tool's description sits with what it does.
- **The gateway** does what is the same for every tool: list, describe, check, run. The agent Bot's own tools are registered only for it (A48); for another Bot they stay unknown.
- **Shared steps** in one context: finding a chat, member or channel group by what the Bot wrote, sending, asking on a card, the unread hint (A53), the check that a person can answer.
- **What a Bot sees is unchanged** except the order of `list`, now by area: names, descriptions, parameters, results and every error text are the same (compared tool by tool for an ordinary Bot and the agent Bot).

Why: a tool is one thing — what the Bot reads about it and what it does — and adding or changing one should be one edit the compiler checks.

## A65 Each kind of work environment once

`BotEnvironments` branched on `record.kind` in fourteen places: opening, the name and directory a Bot sees, `environments.list`, what a switch prepares, the `about` text, the key an open environment is cached under, which records may be a default or be granted. Two more such branches sat in `service/bot/workspace.ts` and `infra/pi/environment-tools.ts`, where `kind === "host"` meant "runs on this machine". Adding a kind meant finding all of them, and the ones missed failed quietly.

- **`service/bot/kinds/`**, one file per kind (`host.ts`, `sandbox.ts`, `ssh.ts`), each an `EnvironmentKindEntry`: `open`, `place`, `ensure`, `connects`, `summary`, `describe`, `about`, `signature`, `home`, `grantable`. `kinds/index.ts` maps `EnvironmentKind` to them, and `BotEnvironments` looks the entry up.
- **`WorkEnvironment.local`**: whether the environment runs on the machine Jarvy does. The two infra branches ask that instead of the kind, which keeps the interface, not the service layer, as what they depend on.
- **Left as they are**: the prompt's Workspace and Work environment sections (they describe the Bot's *default*, which is chosen by `HomeKind`, not by a kind), and `placement`/`setHome`, which take a `HomeKind`.
- **Behaviour unchanged**: `place`, `list`, `summary`, `placement`, `usable` and every `switch` and `grant` result were recorded before and after over a stub store and compared; they are identical, as are the tool copy and the schema.

Why: three kinds is already one more than a chain of `if`s holds well, and an SSH machine is the kind most likely to gain fields. One entry per kind makes each such change one file the compiler checks.

## A66 Attachment contents in files, up to 4 GB

Attachments were BLOBs in `jarvy.db`, up to 10 MB, read and written whole in memory. People need to send files of gigabytes (screen recordings, installers, log archives), which neither the database nor memory should hold.

- **Where**: the `attachments` table keeps what an attachment is (name, type, size, chat, message, uploader); its contents are one file, `<data>/attachments/<first two characters of the id>/<id>`, mode 0600. `infra/files/attachments.ts` owns the files; `service/chat/attachments.ts` puts the two together.
- **Limit**: 4 GB a file, five a message, the same for people and Bots: `ATTACHMENT_MAX_BYTES` in the contract, which the composer's check, the upload route, the service and the Bot's `messages.send` all read. Past it the server answers 413 `file_too_large`.
- **Streams, not buffers**: an upload goes to a part file as it arrives and moves into place once whole; a download streams from the file, ranges included. A Bot's files move between the chat and its environment 4 MB at a time, through two new `WorkEnvironment` operations, `readRange` and `appendFile`, so an SSH machine or a sandbox takes a large file the same way the host does.
- **Time**: the HTTP server has no overall request time limit; the upload route cuts a body off after 60 seconds without data instead, so a slow link can take as long as the file needs.
- **Removal**: rows go by cascade from many places (a chat, a Bot's DMs, a draft's pending file). A trigger records each removed id; the files are deleted after those operations and at startup, and startup also removes part files, files no row owns, and anything else under `attachments/`, such as the readable copies (`<id>/<name>`) that versions before A50 wrote there and never removed, with the folders left empty. The startup sweep runs before the server listens and Bots start, while no file can be between being put in place and getting its row. The files follow the database, never the other way round.
- **Bots' messages**: a Bot's file is written aside as it is read, hashed on the way for the message's idempotency key, and put in place just before the message row; it is dropped when the message isn't written or a retry with the same key finds it already written.
- **Upgrade (v28)**: each row's bytes are written out before the column is dropped, so a stop midway loses nothing and the next start finishes the job; the database is compacted after. On a copy of a real database (571 attachments, 157 MB) it took about two seconds, and the database went from 163 MB to 5 MB.
- **Composer**: an uploading file's chip shows its progress in percent and can be cancelled.
- **Not changed**: the in-page preview still stops at 1 MB for files that aren't pictures, audio or video, and `files.view` still shows pictures up to 4 MB and text up to 64 KB.

Why: a file of gigabytes belongs in the file system, where it can stream, and a database of metadata stays small, fast to back up and quick to migrate.

## A68 Every Bot works on a computer of its own

A Bot's default environment was either its sandbox or the owner's computer, and most Bots defaulted to the owner's computer. Bots on it shared one machine, and nothing in their instructions said that the others might not: a Bot would hand another a path, a `localhost` address or a machine only it could reach. Jarvy also ran those Bots' commands itself, as the owner.

- **One default**: every Bot's default is its own Docker sandbox, the container Jarvy makes for it alone with its workspace as `/workspace`. `HomeKind` is gone; the choice of default is gone from Bot info, a new Bot's first setup, `POST /bots` and the agent's `bots.create`.
- **No owner's computer kind**: the computer running Jarvy is an SSH machine like any other, added in Settings and granted to Bots (A57). Kinds are `computer` and `ssh`; `PUT /bots/:id/environment` takes only `{machineId, granted}`. Reaching it over SSH gives it the same host-key check, grant and revocation as every machine, lets the owner give Bots a less privileged account, and leaves Jarvy running no Bot command itself.
- **New Bots**: get their sandbox when they are created, the row at once and the container in the background when Docker is there; a live Bot without one at startup (the agent Bot on a new installation, one restored) gets one then.
- **Without Docker**: a Bot still has its sandbox as its default and still runs. Its file and command tools fail until Docker is available; its chat tools work as usual, and Bot info shows the sandbox as unavailable, needing Docker.
- **Upgrade (v29)**: every Bot whose default wasn't its sandbox gets one (the row only; the container is made on first use) and is placed there, as its default and where it is now. Its files stay where they were: the sandbox mounts the same workspace folder. The owner's computer's rows are deleted with their grants, since SSH needs the owner's password or key once and can't be granted for them; a Bot working there is back on its sandbox. Grants of SSH machines are kept, and a Bot on one stays there. The owner adds the computer running Jarvy as a machine and grants it again, before the upgrade to keep Bots working there without a gap.
- **Instructions**: one Workspace and Work environment text for every Bot: its workspace on its own computer; other members work on their own machines and can't reach its files, addresses or what it starts, nor it theirs; files go across as attachments, anything else in the chat; how to switch to an external environment. A Bot's prompt changes once with the upgrade and is told so (A56).
- **Bot info**: its Docker sandbox, with its state and what it is made of (container, image, workspace mount point) and its actions; then the external environments, one switch per SSH machine, or Add machine when there is none.

Why: each Bot works as one person with one computer, and what it shares, it shares through the chat. One kind of default leaves one text to tell Bots where they are, and one way to reach every other machine.
