# Domain

[Index](../index.md) · [Layout](layout.md) · [ADR](../decisions.md)

Jarvy is built around a Bot's working environment: its continuous context, its chats and its memory. It runs on the Pi coding-agent SDK, but no product concept depends on Pi.

```text
Member
  ├─ User
  └─ Bot
      ├─ identity / model / workspace / tools / memory
      └─ agentRuntime / state
Chat (dm | channel | thread)
  └─ info / members / messages
```

- **Member** is a participant with a stable ID, a name and `send` / `deliver`. People and Bots are the same to every layer above the member itself; they differ only in how they respond to a delivery (A41).
- **Bot** is an object with behaviour, not a configuration row: identity, description and persona, a model selection, a workspace, tools, memory, a runtime and live state.
- **Chat** has an ID, type, title and members, and owns the chat rules, message storage and history queries. Between any two members there is at most one DM. Channels belong to optional channel groups (sections); a thread is its own chat tied to a parent channel and a root message, and inherits the channel's access ([channels](channels.md)).
- **One Pi session per Bot**, shared across all its chats (A03). What a chat shows and what is in the Bot's context are different sets.

The seven Bot parts and three Chat parts are objects with methods, not grouped fields.

## Responsibilities

| Boundary | Does | Does not |
| --- | --- | --- |
| Member / User / Bot | identity, send / deliver; a Bot runs its configuration and lifecycle | carry cookies, SQL rows or Pi schemas |
| Chat | type, members, rules for speaking, message queries | keep unbounded history in memory, drive SQL, web connections and agents at once |
| ChatService | trusted actor, membership checks, validation, idempotency, transactional save, dispatch after commit | guess how a model thinks or pick targets for it |
| delivery | who receives an event, why, and how urgently | know about Pi or the UI |
| AgentRuntime | one serial input pump per Bot, its single session, state, stop and resume | act as chat storage or pass plain text off as a reply |
| Pi adapter | SDK setup, event mapping, tool registration, models and credentials | leak Pi provider IDs or extensions into the domain |
| Storage | SQL, migrations, atomic writes, row ↔ domain conversion | start the SDK or the network inside a transaction |
| Web API / SSE | auth, request validation, DTOs, notifications | trust `senderId` / `ownerId` from a request body or drive Pi |

## Data that must stay distinct

| Concept | Meaning |
| --- | --- |
| ChatMessage | a saved fact: chat, author, order, text and attachments, time, optional reply target |
| Membership | which member may read or write which chat |
| Inbox row | something delivered to a member, with its reason and urgency; being queued does not mean Pi has seen it |
| BotRun | one execution with its ordered inputs, model snapshot and result |
| BotState | lifecycle, activity, context usage and last error of the live runtime; never restored as "thinking" after a restart |
| Memory | the Bot's memory part; today it manages the Bot's own History |

Authors are member IDs, not `role=user/assistant`. Order inside a chat and a Bot's arrival order are separate; one batch can come from several chats, so a run has no single origin chat.

## Workspace and tools

A workspace is an ordinary local folder and the Pi `cwd`; it is not a sandbox. Enabled tools: `bash`, `read`, `edit`, `write`, `chat` and `codemode`.

## Permissions

There is one account today, but methods and data always carry the actor, membership and owner.

- A person's identity comes from authentication; a Bot's from the runtime it is bound to. Tools cannot claim an author.
- Reading, searching and sending all check membership. A Bot may send to any chat it can access, not only where its input came from.
- Model connections and Bots belong to an owner.
- A Bot's shared context does not isolate what one member tells it from another. Before several people share Jarvy, rules for passing information on must be decided.
