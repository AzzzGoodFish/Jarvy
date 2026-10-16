# Bot input (XML)

[Index](../index.md) · [Delivery](delivery.md) · [Tools](tools-and-prompt.md)

Chat text is stored in SQLite; the XML a Bot reads is derived from it (`service/chat/envelope.ts`). One prompt can carry messages from several chats, and every message says exactly where it came from. Chats and members are defined once at the top of a batch and messages refer to them by ID (A15). Tags have no product prefix.

## `<chat_batch>`

```xml
<chat_batch bot="bot_2">
  <chat id="c-dev" type="channel" title="研发" section="Jarvy"/>
  <chat id="t-12" type="thread" title="数据模型" parent="c-dev" root="m180" status="open"/>
  <chat id="d-1" type="dm" title="Alice"/>
  <member id="u1" name="Alice" kind="user"/>
  <member id="b3" name="Mochi" kind="bot"/>
  <message id="m201" chat="c-dev" from="b3" at="2026-10-08T08:00:00Z"><text>@Arch 未读数按成员算吗？</text></message>
  <message id="m207" chat="t-12" from="u1" at="2026-10-08T08:00:01Z">
    <reply_to message="m205" from="b3">迁移草稿在这里</reply_to>
    <text>@Arch 看一下</text>
  </message>
  <message id="m208" chat="d-1" from="u1" at="2026-10-08T08:00:02Z">
    <text>日志在附件里</text>
    <file id="9f2c…" name="run.log" type="text/plain" size="18 KB"/>
  </message>
  <updates><notice chat="c-dev" version="3" by="u1" at="…"/><summary chat="t-12" version="2" by="b3" at="…"/></updates>
  <notices>
    <reaction message="m150" chat="c-dev" by="u1" emoji="👍" at="…">the start of the marked message</reaction>
    <note>These are reactions to your messages. Act on them if you need to; no reply is required.</note>
  </notices>
  <unread total="9"><chat id="c-dev" count="2"/><chat id="c-req" title="需求" type="channel" count="7"/></unread>
  <workspace name="your own computer" directory="/workspace"/>
</chat_batch>
```

| Node | Rule |
| --- | --- |
| `chat_batch.bot` | the receiving Bot; not repeated per message |
| `chat` | each chat once: `id`, `type` (`dm` / `channel` / `thread`), `title`; channels add `section`; threads add `parent`, `root`, `status` |
| `member` | each author (and each replied-to author) once: `id`, `name`, `kind` |
| `message` | `id`, `chat`, `from`, `at` always; document order is arrival order |
| `reply_to` | the replied-to message and its author, with the start of its text |
| `text` | the message text, escaped; omitted for attachment-only messages. Partial quotes are expanded in place (below) |
| `file` | one per attachment: `id`, `name`, MIME `type` and a readable `size`; never a path or contents. The Bot opens it with `files.get` (into its environment) or `files.view` (A50) |
| `updates` | new versions of notices (channels) and summaries (threads) since last told — where, version, editor, time; no content. The Bot reads them with `chats.info` |
| `notices` | reactions to the Bot's messages, quoting the marked message, with a fixed note |
| `changes` | what the agent Bot changed about this Bot (A48), or the owner about where it works (A50): one `change` per field — the DM with whoever changed it, who, which field, when, and the new value (none for a persona) — with a fixed note for each. The owner's fields are `environment` (where its tools run now and the directory there) and `access` (an environment granted or taken back) |
| `onboard` | to the agent Bot only, once (A48): the owner has just given it a model; its note asks for a welcome in the owner's interface language, in the DM it names |
| `unread` | the Bot's unread counts; chats not defined above carry `title` and `type` |
| `workspace` | where the Bot's file and command tools run now (A50): the environment's name and the directory they start in. Last in every batch, so the system prompt need not change when the Bot switches |

## Partial quotes

A message stores its quotes as structure and marks each with `[[qN]]` (A44). Wherever a Bot reads a message — batches, `messages.read`, `messages.search`, a thread's root in `chats.info` — each mark becomes a quote block on its own lines:

```
> Mochi (m123): the passage being quoted
I agree with this part.
```

The source ID is left out when that message is gone; a passage over 200 characters keeps its first 120 and last 60 around 「……」. Previews (`reply_to`, marked messages in `notices`, thread roots in `threads.list`) show a quote as "passage" instead. A message without quotes keeps any `[[qN]]`-like text as it is.

## `<notice_batch>`

Queued deliveries steered into a running turn, or forming a turn of their own when the Bot was idle, use the same shape without messages:

```xml
<notice_batch bot="bot_2"><chat …/><member …/><updates>…</updates><notices>…</notices><changes>…</changes><workspace …/></notice_batch>
```

## Rules

- Every `chat` and `from` resolves to a definition in the same batch. Definitions appear in first-use order.
- Batch IDs, positions, counts, chat sequence numbers and protocol versions stay in SQLite; message IDs are enough for tools to find a message.
- MIME types, sizes and attachment IDs stay in the attachment records.
- Times are ISO 8601 in UTC; zero milliseconds are dropped. Text is never trimmed or reflowed.
- Identity, time and paths come from stored data. Attribute values and text are escaped; characters XML cannot carry are rejected. Text that looks like XML gains nothing.
- Batches are sent with `session.prompt(xml, { expandPromptTemplates: false })`, so message text never triggers Pi templates.
- No keys, tokens or scheduling internals appear in the XML. Escaping does not replace chat authorisation or the attachment readability check.
