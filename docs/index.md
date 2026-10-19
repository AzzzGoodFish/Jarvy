# Jarvy architecture

Jarvy is a local, single-user chat system for people and Bots. A Bot is a member like a person; behind it runs one Pi coding-agent session that is shared by every chat the Bot is in.

## The main path

```text
Person (web) or Bot (chat tool)
  → ChatService: authorise, validate, resolve @mentions
  → delivery: route → policy → inbox rows, in the same transaction as the message
  → after commit: Member.deliver(urgency)
      Bot  → AgentRuntime: interrupt = abort + new prompt; queue = steer or wake; digest = wait
      User → SSE event; the sidebar shows red counts and hint lines
  → AgentRuntime claims everything pending → one <chat_batch> XML prompt → the Bot's Pi session
  → the Bot speaks only by calling chat → messages.send, which comes back through ChatService
```

Plain model text is shown as activity (`texting`), never as a chat message.

## Documents

| Document | Covers |
| --- | --- |
| [Engineering principles](engineering-principles.md) | The ten rules every change follows |
| [Code layout](architecture/layout.md) | `src/web`, `src/server` and the `api → service → infra` layers |
| [Domain](architecture/domain.md) | Member, User, Bot, Chat and their parts; permissions |
| [Delivery](architecture/delivery.md) | Routing, the policy table, the inbox, how Bots and people respond |
| [Bot input (XML)](architecture/envelope.md) | The `<chat_batch>` and `<notice_batch>` formats |
| [Bot runtime](architecture/runtime.md) | Pi session setup, lifecycle, states, model switching, timeouts |
| [The live turn](architecture/live.md) | The running turn in memory, `GET /api/bots/:id/live`, what the cat does (A47) |
| [Tools and prompt](architecture/tools-and-prompt.md) | The `chat` gateway, internal tools, codemode, the system prompt |
| [Work environments](architecture/environments.md) | Where a Bot's file and command tools run; the interface and its adapters (A50) |
| [Models and credentials](architecture/models.md) | Connections, credentials, model catalog and auto-configuration |
| [Memory](architecture/memory.md) | Chat history and Bot History; `history.read`; the activity timeline |
| [Channels and threads](architecture/channels.md) | Channel groups, channels, threads, unread, mentions, the sidebar |
| [Storage](architecture/storage.md) | Data directory, SQLite schema versions, recovery, attachments |
| [Connection](architecture/connection.md) | HTTP on this machine, HTTPS with Jarvy's own certificate beyond it (A51) |
| [Secrets](architecture/secrets.md) | The master key, what is sealed under it, secrets and their grants and uses (A52) |
| [Decisions (ADR)](decisions.md) | Why things are the way they are, and what each decision replaced |

## Not built yet

- A channel-group overview page and folding of long messages.
- Search across all of a Bot's History, and History ranges around each message it sent.
- The `self.mood` tool (moods are stored and shown, but a Bot cannot set its own yet; the live turn shows the stored one).
- Muting for Bots through a tool (the rule already applies to Bots).
- Channel copies of thread replies do not carry the original's mentions; the thread pane loads all replies at once.
