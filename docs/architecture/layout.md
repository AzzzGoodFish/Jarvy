# Code layout

[Index](../index.md) · [Domain](domain.md) · [ADR](../decisions.md)

Frontend → API → Service (business objects such as Chat and Bot) → Infra. No actor framework. Directories and real imports follow this structure (A20).

```text
src/
  web/                       React app: pages, frontend state, HTTP client
    sidebar/ channel/ thread/ dm/ composer/ transcript/
    activity/ usage/ avatar/ files/ question/ bot/ styles/ theme/ components/ui/
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

`tsconfig.json` and `tsconfig.web.json` type-check the server and the frontend; `vite.config.ts` builds the frontend into `dist/web/`, and `scripts/bundle-server.mjs` bundles the server with esbuild into one `dist/server/cli.js` (npm dependencies stay external). The CLI finds the frontend at `../web` next to itself.

## Import rules

- API calls services only — never Store, repositories or Pi. Hono registers every method and path explicitly.
- Services hold business rules and complete objects; they may call Infra and other services' public interfaces.
- Infra never imports Service or API. Database rows, network and SDK objects are converted here; data crossing layers uses `shared/` contracts. Pi types stay in `infra/pi/`, `node:sqlite` in `infra/storage/`.
- `shared/` is not a fifth layer. Only the wiring entry points (`application.ts`, `cli.ts`) depend on every layer.
- `npm run check:architecture` checks import direction, Pi/SQLite ownership and the 500-line limit on server files. `npm run build` runs it. It does not replace checking behaviour.

## Interface languages

The interface comes in Chinese and English (A45), more can be added; everything the model reads from Jarvy is English.

- `web/i18n/`: `en.ts` is the reference dictionary, `zh.ts` covers the same keys, `keys.ts` derives `Key` and `Shape` from the reference (so a missing, extra or wrongly shaped key fails `tsc`), and `index.tsx` holds the current language, `t()`, `rich()`, `useLocale()` and the formatters `formatDate()`, `formatClock()`, `formatDay()` and `formatNumber()` (dates, times and numbers follow the interface language, not a fixed zh-CN).
- The language is picked from the browser on first visit (`zh*` → Chinese, anything else English), switchable in 设置 → 通用 and on the login page, and remembered in this browser. `<html lang>` follows it.
- Strings are resolved while rendering, never at module top level; a module-level constant holds a key. The app root subscribes through `useLocale()`, so switching re-renders in place and open dialogs and panes stay; a `memo` component that shows text (Markdown) calls `useLocale()` itself, since memo skips that re-render. Styles and selectors never match translated text (`aria-label`); they use classes or `data-slot`.
- `scripts/check-i18n.mjs` (part of `check:architecture`) checks key parity, placeholders and empty values, and scans components for Chinese text; files not migrated yet are listed in its `PENDING` set, which can only shrink.
- Failures: `web/errors.ts` words the server's failure codes; `errorText(reason, fallback)` is what a component shows for a failed request, `statusError(status)` for a Bot's run error. A component never shows a server message it did not get through these.
- What people write — Bot personas, notices, summaries, messages — is never translated.

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
