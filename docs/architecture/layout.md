# Code layout

[Index](../index.md) · [Domain](domain.md) · [ADR](../decisions.md)

Frontend → API → Service (business objects such as Chat and Bot) → Infra. No actor framework. Directories and real imports follow this structure (A20).

```text
src/
  web/                       React app: pages, frontend state, HTTP client
    sidebar/ channel/ thread/ dm/ composer/ transcript/
    activity/ avatar/ files/ question/ bot/ styles/ theme/ components/ui/
  server/
    api/
      app.ts                 Hono app and route registration
      server.ts              Node HTTP adapter
      routes/                account, bots, chats, channels, models, history, activity, events (SSE)
      middleware/            same-origin and security headers, request bodies, error mapping
      views/                 HTTP projections
    service/
      bot/                   Bot, its parts, BotService
      chat/                  Chat, its parts, ChatService, mentions, envelope
      delivery/              routes, policy table, plan and dispatch (A41)
      models/                model connections, credentials, catalog queries
      account/               login and its rate limit
      member.ts              Member / User
      events.ts              committed business changes (no HTTP/SSE here)
    infra/
      storage/               Store, repositories, migrations/
      pi/                    Pi session, models, credentials, History conversion, HTTP dispatcher
      credentials/           per-connection credential serialisation
      files/                 workspace and attachment file I/O
      models/                model-list discovery over the network
    shared/                  plain data and call contracts, no business logic
    application.ts           wiring, exclusive data directory, ordered shutdown
    cli.ts                   command line
    daemon.ts                jarvy on / off: background start, pid file, stop
```

`vite.config.ts`, `tsconfig.json` and `tsconfig.web.json` handle the frontend build, server types and output, and frontend types. Output goes to `dist/server/` and `dist/web/`; the CLI is `dist/server/cli.js`.

## Import rules

- API calls services only — never Store, repositories or Pi. Hono registers every method and path explicitly.
- Services hold business rules and complete objects; they may call Infra and other services' public interfaces.
- Infra never imports Service or API. Database rows, network and SDK objects are converted here; data crossing layers uses `shared/` contracts. Pi types stay in `infra/pi/`, `node:sqlite` in `infra/storage/`.
- `shared/` is not a fifth layer. Only the wiring entry points (`application.ts`, `cli.ts`) depend on every layer.
- `npm run check:architecture` checks import direction, Pi/SQLite ownership and the 500-line limit on server files. `npm run build` runs it. It does not replace checking behaviour.

## Bot and Chat

A Bot has seven parts in `service/bot/{identity,model,workspace,tools,memory,agent-runtime,state}.ts` and seven public methods: `start / stop / abort / status / deliver / send / changeModel`. `inbox.ts` turns pending deliveries into a batch; `prompt.ts` builds the system prompt.

A Chat has `info / members / messages` and the methods `deliver / delete`. ChatService creates and looks up chats; deleting a chat never deletes members or Bot History.

```text
HTTP / User.send
  → ChatService → Chat.deliver
  → delivery.plan (routes + policy)
  → ChatRepository: message, attachments, source and inbox rows in one transaction
  → after commit: Dispatcher → Member.deliver(urgency)
      Bot.deliver → AgentRuntime + BotInbox → PiSession

Pi assistant message → Bot.recordHistory → Memory → HistoryRepository
Pi tool call → Tools → Bot.send (bound to its History source) → Chat.deliver
```

## HTTP and lifecycle

- Hono 4.13 with `@hono/node-server` 2.1, which does not replace the global `Request` / `Response`, so the Fetch objects Pi uses in the same process are untouched.
- Cookie login, same-origin checks, JSON and upload limits, read-only History, SSE with re-read after reconnect. Errors map by type, not by message text.
- Bot state is `stop / idle / running`; while running, activity is `reasoning / texting / tool_calling / asking` or null while waiting. `POST /api/bots/:id/start|stop|abort` call the matching Bot methods.
- SSE subscriptions belong to services; encoding, auth and closing the stream belong to the API.

The activity timeline is a read-only composition: the activity route → `BotService.activity` → `ChatService.sentActivity` and `Memory.timeline` → their repositories. It is not an eighth Bot part and has no storage of its own.
