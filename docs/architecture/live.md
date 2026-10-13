# The live turn

[Index](../index.md) · [Runtime](runtime.md) · [Tools and prompt](tools-and-prompt.md) · [Channels](channels.md)

While a Bot runs, the page showing its DM acts the turn out: the 3D cat moves with what it is doing and a dialogue beside it says what it is thinking, muttering or sending, opening into the steps so far (A47). The DM's address may carry `?npc=demo`, which plays a scripted turn instead and adds the prototype toolbar (see below).

## From Pi's events to Jarvy's

`infra/pi/live.ts` translates Pi's session events into `shared/live.ts` types; nothing of the SDK crosses that line.

| Pi | Jarvy |
| --- | --- |
| `message_start` / `message_update` (assistant) | `block_start` / `block_delta` / `block_end`, keyed by message and content index, `kind` `thinking` or `text` |
| `message_end` (assistant) | closes any block still open (an error mid-stream) |
| `tool_execution_start` / `_end` | `tool_start` (id, `parentToolCallId` for a call an extension made, name, args) / `tool_end` (text result, `isError`) |
| `compaction_start` / `_end` | `compaction_start` / `compaction_end` (failed, error, tokens before and after) |
| `auto_retry_start` / `_end` | `retry_start` (attempt, max) / `retry_end` (failed) |

`PiSession.prompt` brackets a run with `start` and `end` (outcome `completed`, `interrupted` or `failed`), so a turn is exactly one Jarvy run: what one `<chat_batch>` prompt made the Bot do.

## The turn in memory (`service/bot/live.ts`)

`LiveTurns`, one per Bot in the `/api` process, keeps the running turn as a list of steps and drops it when the turn ends — what it did is in History. Nothing is written to disk.

- A step: `id`, `kind` (`thinking`, `text`, `tool`, `compaction`, `retry`), `state` (`running`, `ok`, `failed`), `parentId`, start and end times, and whatever its kind carries.
- `service/bot/live-input.ts` summarises a tool call's arguments: the file for `read` / `edit` / `write`, the first line of the command for `bash`, of the script for `codemode`, and for the `chat` gateway the tool inside it — with the chat (`#channel`, a thread's title, a person's name) and the text of a message or a question. `chat` is read as a Bot sees it; a DM is named after the other member. A `messages.send` given a member's name resolves its chat from the tool's result, once it is sent.
- Limits, so a long turn cannot grow without bound: 300 steps (the oldest **finished** ones go first, a running one never), the latest 4,000 characters of each thinking or text block (with how many were left out), 1,200 characters at each end of an output, 300 for an input summary, 2,000 for a message's text.
- Changes are batched every 100 ms: a step added or changed goes whole, streamed text goes as what was appended, and a dropped step says so. A page that joins mid-turn gets the turn so far first.

## The interface (`GET /api/bots/:id/live`)

An SSE stream with its own connection, not the app's `/events`. Only the Bot's owner, signed in, may listen.

| Event | Data |
| --- | --- |
| `snapshot` | `{ turn, now }` — the turn so far or `null`, and the server's clock for running times |
| `start` | `{ type, turn }` — a new turn, empty |
| `patch` | `{ type, patches }` — `step` / `text` / `drop` |
| `end` | `{ type, outcome, endedAt }` |
| `heartbeat` | every 15 s; the session is re-checked |

A reader that falls behind (`desiredSize <= 0`) is disconnected, as on `/events`, and reconnects to a fresh snapshot. The server words nothing: `web/avatar/npc/live-view.ts` turns steps into sentences with `t()` (A45).

## What the cat does

`web/avatar/npc/` holds the whole layer:

- `figure.ts` (the 3D body) gained `read` (holds a page), `turn` (faces you), `ask` (head tilted), `yawn` (compacting), `stretch` (a turn ended) and `groom` (idle).
- `live.ts` subscribes while the DM is open and keeps the turn, plus the last turn that ended while it listened.
- `live-view.ts` words a step and picks its motion: thinking → think; the model's own text → a murmur, typing slowly; `read` and the looking chat tools → a page held; `edit`, `write`, `bash`, `codemode`, other chat tools → typing fast; `messages.send` → facing you; `messages.ask` → head tilted; compacting → a yawn; retrying → fidgeting.
- `pick.ts` decides what the dialogue shows: a message being sent; else words or a failure still up (queued in the order they ended — a newer message cuts the line before it short, but not under 1.5 s); else what runs, unless that is thinking; else a quick tool call that just ended; else what runs. Nothing more than 4 s after the fact.
- `NpcLayer.tsx` renders it: a round thought bubble with a tail of circles (one sentence at a time), a frameless murmur in brackets, a named speech box with a `→ #chat` tag for a message sent elsewhere, an action pill for tools and for how the turn ended. Opening it shows every step with its state, time, input and output; calls a tool made are indented under it. The cat turns towards the middle of the chat — to the right at the left edge, to the left at the right edge, straight at you in the middle — and the pointer pulls its body and eyes a little. The layer comes out of the side the cat faces, right next to it (the other side when there is no room, below or above it on a narrow screen), follows it when dragged and never covers the composer (`place.ts`).
- The mood comes from the Bot's stored mood; a failed step flashes dizzy and shakes the cat, a turn of over 20 s that completes flashes happy and stretches, then the base mood returns. After a turn the 「done」 line (or 「被打断了」 / 「这一轮失败了」) stays 6 s and fades; a click on the cat within 10 minutes brings it back, otherwise a click opens Bot info as usual.
- An idle cat grooms now and then (after 30 s idle, every 20 s, for 2.8 s).

## The scripted demo (`?npc=demo`)

`script.ts` holds a made-up turn (thinking, reading, editing, a failing build, compacting, a post to another channel, a question, the reply) and `POSES`, one per state. `useNpcDemo.ts` plays it with the same `NpcDriver` shape as the live turn, so the same dialogue renders both; `NpcToolbar.tsx` is the prototype toolbar (replay, base mood, one button per state) and appears only with the parameter. The demo needs no server and drives the README's pictures.
