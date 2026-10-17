# Storage

[Index](../index.md) · [Delivery](delivery.md) · [Runtime](runtime.md)

## Data directory

The default is `~/.jarvy`; `JARVY_DATA_DIR` or `--data-dir` replaces the whole root (A08). One process owns a data directory at a time (a lock held until shutdown finishes).

```text
<data-dir>/
  jarvy.db                             business data and credentials (0600)
  jarvy.pid, jarvy.log                 background server (jarvy on)
  bots/<botId>/
    history.db                         the Bot's History
    workspace/                         Pi cwd; an ordinary folder, mounted as /workspace in the Bot's sandbox
      temp/
    agent/pi/sessions/<timestamp>.jsonl   the Bot's one session file
  pi/models.json                       pi.dev's model catalog as last fetched (A49)
  computers/bin/pi-env                 the daemon Bots' sandboxes mount read-only (A50)
  computers/build.log                  output of the last build of their image
```

| Data | Owner |
| --- | --- |
| identity, chats, members, messages, inbox, model connections, credentials, runs, session file references | SQLite (`jarvy.db`) |
| model conversation, thinking, tool calls and results, compaction | Pi JSONL, written by the SDK |
| the Bot's interaction messages | `history.db` ([memory](memory.md)) |
| work files | the Bot's workspace |
| uploaded attachments | SQLite BLOBs; files on disk are rebuildable copies |
| current activity, context usage | the live runtime only; never restored from an old snapshot |

The session file name is chosen once per Bot and stored with the Pi session ID; it is always reopened, never guessed and never created per chat.

## Recovery

| At restart | Handling |
| --- | --- |
| only unclaimed deliveries | wake the Bot and process normally |
| claimed but not submitted to Pi | release the claim; nothing is lost |
| submission started, end unknown | mark `unknown`; never replay tools with side effects automatically |
| session file exists | open the registered path and check the session identity |
| file never written | keep the same path; Pi 1.2.0 writes the file with the first user or assistant message |
| file was written but is lost or corrupt | fail explicitly; never replace it with an empty history |

Pending question cards are marked ignored at startup, since no tool call outlives the process.

## Attachments

Up to 10 MB each and 5 per message; the database holds them. Into a Bot: the XML lists each by id, name, type and size; `files.get` writes it into the Bot's current environment and `files.view` hands a picture or short text to the model (A50). Out of a Bot: `messages.send` takes `{path, name}` in its current environment; the server reads the file through it and saves it to the target chat. Images reach the model only when a Bot asks (`files.view`, or `read` on a file it got); PDFs, audio and so on need tools that can read them. `GET /api/attachments/:id` serves single byte ranges (206 / 416) and the file's own type only for the fixed media list in A34; anything else is `application/octet-stream`, always with `Content-Disposition: attachment`.

## Schema versions

Migrations run at startup, in `infra/storage/migrations/`, and only move forward. Each keeps existing IDs and data. A downgrade means restoring a backup taken before the upgrade, with the matching build.

| Version | Change |
| --- | --- |
| v7 | `messages.history_id` / `tool_call_id` (send source); `chat_members.can_read` |
| v8 | `installation(device_id)`, created on the first ChatGPT login |
| v9 | message IDs become `m<position>` (a global, never-reused sequence); references rewritten in the same transaction. Other IDs stay UUIDs (A32) |
| v10 | `bots.color` (one of six, random) and `bots.mood`; uploaded avatar columns removed |
| v11 | `messages.question` (JSON question card) |
| v12 | `sections`, `chat_notes`, `chat_states` (read position, following, note seen), `message_mentions`; channel and thread columns on `chats`. Read positions start at each chat's latest message, so upgrading creates no unread backlog. Member names become unique |
| v13 | `messages.echo_of` (channel copy of a thread reply) |
| v14 | `chat_states.subscribed` |
| v15 | `messages.reply_to`, `message_reactions`, `chat_states.pinned`, `bots.deleted_at` (soft delete) |
| v16 | `inbox` replaces `bot_pending` and `bot_notices`; `chat_states.muted` |
| v17 | `message_quotes`: a message's partial quotes by mark position — source message (cleared when it goes), its sender, the quoted text (A44) |
| v18 | An untitled DM's title is `""` instead of the placeholder 「新对话」; the first message still names it. No column changes; titles people or first messages gave stay (A45, 0.3.0) |
| v19 | `settings(key, value)`, first key `agent_onboarded` (set on upgrade when the agent Bot already has a model); `inbox.kind` gains `onboard` and `change`, the table rebuilt with its rows, indexes and id sequence (A48) |
| v20 | `environments` (owner, kind `host` or `computer`, name, connection, directory, the Bot a sandbox (`computer`) belongs to; soft delete) and `environment_grants`; `bots.home_environment_id` and `current_environment_id`, NULL meaning the owner's computer, so Bots from before stay there (A50) |

## Search

Chat search works within the chats a member can read. Searching all of a Bot's History, compaction summaries, tool results and attachment contents is a goal, not built. When it is, the index stays a rebuildable projection that keeps source references, inherits the original data's access rules and excludes secrets; short Chinese words need tokenizer testing first.
