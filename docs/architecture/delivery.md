# Delivery

[Index](../index.md) · [Bot input](envelope.md) · [Runtime](runtime.md) · [Channels](channels.md)

Something happens — in a chat, or to a member outside any chat; delivery decides who should know, why, and how urgently; each recipient decides how to respond (A41, A61).

```text
source                           routing and delivery (service/delivery)       handling
what happened             ──►    routes:  who receives it, and the reason  ──►  Bot:  AgentRuntime by urgency
                                 policy:  kind × reason → urgency               User: SSE + sidebar by urgency
                                 inbox rows written with the fact (A04)
```

- Chat sources (`Chat.deliver`, `ChatService.react`, `ChatChannels.setNote`) only say what happened; a route turns it into targets.
- System sources (the agent service, a Bot's work environment, the scheduler) name one recipient and a reason through `Deliveries.notify`; there is no chat to route in.
- Routing reads relationships (members, mentions, reply target, subscriptions, followers) and returns targets. It knows nothing about Pi or the UI.
- Handling looks only at urgency. The kind only affects how a delivery is shown.
- Storage writes the rows it is given and holds no routing rules. All inbox SQL is in one repository (`infra/storage/inbox-repository.ts`).

## Three categories (A61)

| Category | Kinds | Has | Never has |
| --- | --- | --- | --- |
| `message` — a chat message | `message` | chat, message | — |
| `activity` — something in a chat | `reaction`, `note` (a new notice or thread summary version) | chat; a reaction also the marked message | — |
| `system` — a notice to one member | `onboard`, `change`, `task` | recipient | chat, message |

The recipient of a system notice can be a person or a Bot; so far only Bots get them. Nothing opens or creates a DM to carry a notice.

## Types (`shared/delivery.ts`)

```ts
type Urgency = "interrupt" | "queue" | "digest";
type DeliveryKind = "message" | "reaction" | "note" | "onboard" | "change" | "task";
type DeliveryCategory = "message" | "activity" | "system";
const CATEGORY: Record<DeliveryKind, DeliveryCategory>;
type DeliveryReason = "dm" | "mention" | "reply" | "subscription" | "author" | "member" | "follower" | "setup" | "agent" | "owner" | "move" | "schedule";
interface DeliveryPayloads {               // what each kind carries, stored as JSON in inbox.payload
  message: null; reaction: { emoji: string }; note: { version: number };
  onboard: { language: WelcomeLanguage }; change: { what: ChangeField; value: string | null }; task: { task: string; due: number };
}
interface Delivery { member: MemberIdentity; reason: DeliveryReason; kind: DeliveryKind; urgency: Urgency }
```

## Routes (`service/delivery/routes.ts`)

| Kind | Recipients | Reason |
| --- | --- | --- |
| message in a DM | the other member | `dm` |
| message in a channel or thread | members @-mentioned in the text; the author of the replied-to message; subscribers | `mention`, `reply`, `subscription` |
| channel copy of a thread reply | channel subscribers that did not get the thread reply | `subscription` |
| reaction | the author of the marked message, if it is not the one marking | `author` |
| note | channel members (notice) or thread followers (summary), except the editor | `member`, `follower` |

System notices have no route; the source names the recipient:

| Kind | Recipient | Reason |
| --- | --- | --- |
| onboard | the agent Bot, when it first has a model (A48) | `setup` |
| change | a Bot the agent Bot changed (A48) | `agent` |
| change | a Bot whose work environment the owner changed (A50); `move` when a running Bot was moved | `owner`, `move` |
| task | the Bot whose scheduled task is due (A58) | `schedule` |

The sender is never its own recipient; each member gets at most one row per message.

## Policy (`service/delivery/policy.ts`)

```ts
message:  { dm: "interrupt", mention: "interrupt", reply: "interrupt", subscription: "interrupt" },
reaction: { author: "queue" },
note:     { member: "queue", follower: "queue" },
onboard:  { setup: "interrupt" },
change:   { agent: "digest", owner: "digest", move: "interrupt" },
task:     { schedule: "queue" },
```

Urgency is decided only here. A move (a new default, or the owner's computer taken back while the Bot is there) of a Bot that is running is reason `move`, so it doesn't go on in the old place; a Bot that isn't running, and a change of access alone, are `owner`: there is nothing to stop, and waking it would only spend a turn.

**Mute** is a per-recipient override: in a chat the recipient muted (a thread follows its channel), `interrupt` becomes `queue` unless the reason is `mention` or `reply`. It applies to people and Bots alike.

## The one way in (`service/delivery/delivery.ts`)

`Deliveries` is made once by the application and shared:

- Chat sources call `plan(kind, targets, muted)`, write the fact and the deliveries in one transaction, and after commit `deliveries.dispatch(...)` calls `Member.deliver(urgency)` for each recipient.
- `deliveries.notify({to, kind, reason, actorId, payloads})` plans, writes and dispatches system notices; several payloads at once (changes made together) wake the recipient once.
- The scheduler writes a due task's row in the transaction that moves the task on (A58), then dispatches it.

## The inbox (v16, v26)

One table, `inbox`, holds every delivery: member, category, kind, reason, urgency, chat (none for system notices), message (only for messages and reactions), actor, `payload` (JSON shaped by kind), state, run, timestamps. CHECKs keep the category's fields; the kind is checked in code, so a new kind needs no rebuild.

- A Bot's message rows move `pending → claimed → done | failed | interrupted | unknown | cancelled`, tied to the run that claimed them.
- Everything else moves `pending → told`. Removing a reaction before it was told withdraws the row.
- Unread is state, not an event: it is still computed from each member's read position.

## How a Bot responds

`AgentRuntime.deliver(urgency)`:

- **interrupt** — abort the running turn (Pi `abort`) and start a new one with everything pending (A05).
- **queue** — if a turn is running, steer the pending reactions and notes into it as a `<notice_batch>` (Pi `session.steer`); otherwise wake the Bot for a turn of its own. A due task is never steered: it waits for the running turn to end and comes in the next one (A58).
- **digest** — nothing now; it goes with the next batch.

One pump per Bot claims everything pending at that moment: messages become `<message>` elements of one `<chat_batch>` prompt, untold reactions are appended as `<notices>`, new note versions as `<updates>`, system notices as `<changes>`, `<onboard>` and `<tasks>`, and the batch ends with `<unread>` ([format](envelope.md)). Each queued item is told once. At startup, Bots with pending rows are woken, the most urgent first. Queued messages (from muted chats) are handled after the current turn rather than steered in.

Further rules:

- Messages arriving while a turn is being aborted join the next claim; there is one abort and one prompt, not one per message.
- One pump and one prompt in flight per Bot; Bots do not block each other.
- Side effects already done (messages sent, files written) are not rolled back by an abort.
- No pre-splitting of very large batches. A real context error is kept for diagnosis; messages are not dropped or retried forever.

## How a person responds

`User.deliver` publishes an SSE `inbox` event and the sidebar refreshes ([channels](channels.md#sidebar)):

- **Red count**: pending interrupt messages delivered to you and not yet read (`Chat.alerts`). A red 「[有人@我]」 prefix shows while one of them @-mentions or replies to you (`Chat.atMe`).
- **Hint line**: the newest queued delivery — 「Jarvy 对你的消息表达了 👍」, 「Mochi 更新了公告」 (`Chat.hint`). For a channel, its threads count too: the hint names the thread (「Jarvy 更新了线程「…」的摘要」) and opening the row opens that thread beside the channel.
- **Grey count**: other unread messages, including muted ones.
- Reading a message marks its row told; opening a chat marks its other rows told.
- The tab shows the red total as a favicon badge and a 「(N)」 title prefix (`web/tabBadge.ts`).

## Idempotency and recovery

- HTTP sends are idempotent per actor through `clientMessageId`; the same key with different content is a conflict.
- A Bot's tool send uses a key derived from `(botId, historyId, toolCallId)`, so retrying the same call does not post twice.
- Repeated wake-ups reach the same pump; a lost wake-up is recovered by the startup scan.
- Access is re-checked when claiming.
- A run whose submission to Pi started but whose end is unknown is marked `unknown`, never replayed automatically. Pi's JSONL and SQLite cannot commit atomically together.

## Send source

Messages have nullable `history_id` / `tool_call_id`, pointing at the saved assistant History row and the call inside it. The Bot binds them before calling `Chat.deliver`, and they are saved with the message. The API returns `source: {historyId, toolCallId} | null`; people's messages, old messages and sends that match no saved call (for example inside codemode) have `null`. The source links messages to History in the activity timeline; reading it still requires owning the Bot.

## Pi events

| Pi event | Meaning in Jarvy |
| --- | --- |
| `thinking_delta` | reasoning activity |
| `text_delta` | `texting` activity, never a chat message |
| `tool_execution_start/end` | tool activity; not a boundary for a new prompt |
| `agent_end` | not the end: Pi may still retry or continue |
| `agent_settled` + the prompt promise resolved | the turn is over |

A turn that ends without `messages.send` produces no chat message and no "no reply" notice.

## Adding a kind

A new kind needs its category and payload (`shared/delivery.ts`), a policy row, a route if it is about a chat, and its rendering in the Bot envelope (and in the sidebar, for people). `AgentRuntime`, the inbox table and the SSE channel stay as they are.
