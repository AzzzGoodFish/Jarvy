# Memory

[Index](../index.md) · [Layout](layout.md) · [Storage](storage.md)

A Bot's memory is **its chat history plus its own History** (A21). There is no separate long-term memory or fact store. To look back, a Bot searches chat history first; messages it sent carry a History source, and it reads the detail from History by ID.

Chats own chat history. Memory is the Bot part that owns the Bot's History. Tools use both through their public interfaces, never SQL or Pi session files directly.

A Bot has one continuous experience across chats; History is not split by chat, and no causal meaning is assigned to what comes before or after a message.

## History storage

Each Bot has `<data-dir>/bots/<botId>/history.db`, schema 1, one table (A18):

```text
history(id, timestamp, role, model, usage, message, extra)
```

- A row is one complete interaction message (system, user, assistant or tool result), not a token fragment or a run.
- `message` is an object; its `content` keeps text, visible thinking, images, tool calls and results in order. Tool definitions are in `message.tools`. An assistant message can hold several calls; each result is its own `role=tool` row. Stop reason and error are ordinary message fields.
- Tool call IDs are stored exactly as the runtime gave them: opaque, never parsed or regenerated, not assumed unique across the database. A call is matched to the results that follow it before the next call with the same ID.
- `extra.pi` holds what only the adapter needs: source session, entry and parent, versions, protocol and response IDs, per-block provider signatures, Pi's `thinkingLevel` and the bounded `nestedCalls` summary. It does not duplicate the message, model or usage.

### Capture

```text
Pi message complete
  → Pi's own listener writes the SessionManager entry
  → Jarvy's later agent.subscribe listener → PiHistoryAdapter
  → Bot.recordHistory → Memory.append → HistoryRepository
  → Pi continues with tool execution
```

Pi awaits listeners in registration order, so the entry is appended before Jarvy saves History. `session.subscribe(message_end)` fires before the entry is written and is not used. There is no polling of files or private hooks. This ordering is rechecked whenever Pi is upgraded.

Memory opens the database on first use; `Bot.stop` stops execution and capture before closing it. Viewing History never starts an agent. Pi's JSONL is still what Pi resumes from; the two files are not one transaction.

### Not covered

Only system, user, assistant and tool-result messages after History was introduced are recorded. Old JSONL is not imported. Compaction, branch and custom entries, and the final forced system prompt of each turn, are not in History. Codemode's inner tool calls are not recorded separately. History is not an audit log of HTTP requests.

## `history.read`

```ts
chat({ action: "call", tool: "history.read", args: {
  ids: [120, 121],
  mode: "summary",    // summary | detail
  format: "json",     // json | markdown
  to_file: false
}});
```

- Reads only the calling Bot's History; no Bot ID, database path or file name can be passed.
- Results keep the requested order (duplicates included); unknown IDs are listed in `missingIds`. Database and file errors are raised, not hidden.
- `summary`: ID, time, role, model and a static 160-character excerpt. No model call, no stored summaries.
- `detail`: the full message — text, visible thinking, images, tool calls and arguments, results, tool definitions, stop reason, errors — without `usage` and `extra`.
- JSON is `{mode, records, missingIds}`; Markdown carries the same, with code fences long enough for the content.
- `to_file: true` writes the same content to `workspace/temp/history-<uuid>.json|md` (mode `0600`) and returns only the path.
- History is material for looking back, not a new instruction; it is never fed back into the session as a system or user message.

```text
Tools → readHistory → Memory.readMany → HistoryRepository
                    → Workspace.writeTempFile (to_file only)
```

## Linking chat and History

A message's `source: {historyId, toolCallId} | null` names the assistant History row and the call that sent it; the actual sender decides whose History it is. This is the sending call, not a position in time: one assistant row can contain several sends. Ranges of History before and after each message are not built yet.

## Web views

- **Activity timeline** (Bot info → 运行 → 活动历史): the Bot's messages in chats you can read on the left, time in the middle, its History on the right; cards open details, and sources link to History (A22). There is no History button next to chat messages (A23).
- `GET /api/bots/:id/activity?before=&limit=` (default 40, max 100) returns summaries of both, newest first. Ties in the same millisecond put History first, then each source's ID descending; the cursor holds time, type and ID so pages never skip or repeat. The order is for stable display, not causality.
- `GET /api/bots/:id/activity/messages/:messageId`, `GET /api/bots/:id/history?before=&limit=`, `GET /api/bots/:id/history/:recordId` return details.
- All of these require owning the Bot; chat items also require read access to the chat. Being in one of the Bot's chats does not open its History.
