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

Messages show image thumbnails and file cards; the viewer previews images, Markdown, text and static HTML (scripts, frames, external loads and event attributes removed, in a `sandbox=""` iframe with a deny-all CSP), with full-window mode and navigation between a message's files. The backend and page CSP are unchanged: SVG is read as text and shown as a `data:` URL.

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

**Why:** at about 490k tokens a single request took longer than Pi's 300 s idle timeout, compaction (which reads the whole session) timed out too, and every turn failed. Pi's request timeout is set to 900 s (`httpIdleTimeoutMs`). Node's global undici dispatcher, which the Pi CLI configures but the SDK does not, also gets 900 s header and body timeouts (`infra/pi/http.ts`, mirroring Pi's `configureHttpDispatcher`; `undici` pinned to Pi's version). Compaction keeps Pi's defaults and follows the model's window. Compaction start, end and failures are logged. Risk: near a full window a single request may still exceed 900 s.

## A41 Delivery pipeline

Three layers ([delivery](architecture/delivery.md)):

- **Message sources** (`service/chat`) report events: messages, reactions, new notice or summary versions.
- **Routing and delivery** (`service/delivery`) decides recipients and reasons, maps kind × reason to `interrupt / queue / digest` through one policy table, and writes the inbox in the same transaction as the fact.
- **Handling** looks only at urgency. A Bot aborts and re-prompts, steers or wakes, or waits. A person's sidebar shows red counts, hint lines and the tab badge.

Further decisions:

- People and Bots are routed, prioritised and stored the same way.
- Policy: messages (DM, @, reply, subscription) interrupt; reactions and new notice / summary versions are queued, and the editor is not told. This supersedes A37's "attach once to the next batch".
- Storage holds no routing rules. `bot_pending` and `bot_notices` become one `inbox` table (v16).
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
- **Sending** (`POST /chats/:id/messages`, `quotes: [{ messageId, text }]`): at most 10; every marker matches one quote and every quote is marked; the source is in the same chat, or is the thread's root when sending in a thread, and readable by the sender; the text is part of the source, compared ignoring whitespace and Markdown markup. Anything else is a 400. Copies to the channel (`alsoToChannel`) keep the quotes.
- **Interface**: on desktop, selecting text in a message offers 「复制」 and 「在回复中引用」; the composer shows each quote as a removable tag 「名字：开头…」 on its own line, and it belongs to the chat's draft. In a message the tag jumps to the source and highlights the passage, or the whole message when the passage cannot be found, or says the source is gone. Phones show and follow quotes but do not create them yet.
- **Delivery to a Bot**: each marker becomes a quote line `> 名字（m123）：片段` (without the ID when the source is gone); over 200 characters keep the first 120 and the last 60 around 「……」. The same expansion is used wherever a Bot reads messages (`messages.read`, batches). History and storage keep the structure. Sidebar digests show the passage in 「」.
- Not covered: Bots creating partial quotes, quoting across chats, quoting attachments, quotes inside quotes.
