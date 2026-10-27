# Code layout

[Index](../index.md) · [Domain](domain.md) · [ADR](../decisions.md)

Frontend → API → Service (business objects such as Chat and Bot) → Infra. No actor framework. Directories and real imports follow this structure (A20).

```text
src/
  web/                       React app: pages, frontend state, HTTP client
    sidebar/ channel/ thread/ dm/ composer/ transcript/
    activity/ usage/ avatar/ files/ question/ bot/ environment/ connection/ secrets/ styles/ theme/ components/ui/
      avatar/               the 3D Bot (figure.ts; the agent Bot's crown, crown.ts), its DM layer (npc/) and colours
      action.ts             useAction(): a request in flight and its worded error, for any component that sends one
      question/RequestCard  the panel a secret or SSH machine request shows in (and its masked field)
      secrets/SettingsItem  an expandable settings row with in-place delete (secrets, SSH machines)
  server/
    api/
      app.ts                 Hono app and route registration
      server.ts              Node HTTP adapter; HTTP and HTTPS on one port beyond this machine (A51)
      routes/                account, bots, chats, channels, models, history, activity, events, live (SSE), connection and secrets
      event-stream.ts        the SSE stream both events and live use: heartbeat, back-pressure, sign-out, cleanup
      middleware/            same-origin and security headers, request bodies, error mapping
      views/                 HTTP projections
    service/
      bot/                   Bot, its parts, BotService, the live turn (live.ts)
      chat/                  Chat, its parts, ChatService, mentions, envelope
      delivery/              routes, policy table, plan and dispatch (A41)
      models/                model connections, credentials, catalog queries
      account/               login and its rate limit
      member.ts              Member / User
      events.ts              committed business changes (no HTTP/SSE here)
      connection.ts          how Jarvy is reached: its certificate, LAN addresses, whether plain HTTP is allowed (A51)
      secrets.ts             the owner's secrets, their grants and uses (A52)
    infra/
      storage/               Store (opens the database, runs migrations, holds the repositories), one repository per domain (account, bots, model connections, chats, …), migrations/
      pi/                    Pi session, models, credentials, History and live-event conversion, HTTP dispatcher
      env/                   work environments: where a Bot's file and command tools run (pi-env, Pi Durable)
      tls/                   Jarvy's own root and server certificates (A51)
      vault/                 the master key and sealing under it (A52)
      credentials/           per-connection credential serialisation
      files/                 workspace and attachment file I/O; the skills that ship with Jarvy (A55)
      models/                model-list discovery over the network
    shared/                  plain data and call contracts, no business logic
    application.ts           wiring, exclusive data directory, ordered shutdown
    cli.ts                   command line
    daemon.ts                jarvy on / off: background start, pid file, stop
```

The skills that ship with Jarvy are in `skills/` at the package root, one folder per skill (A55).

`tsconfig.json` and `tsconfig.web.json` type-check the server and the frontend; `vite.config.ts` builds the frontend into `dist/web/`, and `scripts/bundle-server.mjs` bundles the server with esbuild into one `dist/server/cli.js` (npm dependencies stay external). The CLI finds the frontend at `../web` next to itself.

## Import rules

- API calls services only — never Store, repositories or Pi. Hono registers every method and path explicitly.
- Services hold business rules and complete objects; they may call Infra and other services' public interfaces.
- Infra never imports Service or API. Database rows, network and SDK objects are converted here; data crossing layers uses `shared/` contracts. Pi types stay in `infra/pi/`, pi-env and Pi Durable in `infra/env/`, `node:sqlite` in `infra/storage/`.
- `shared/` is not a fifth layer. Only the wiring entry points (`application.ts`, `cli.ts`) depend on every layer.
- `npm run check:architecture` checks import direction, Pi/pi-env/SQLite ownership and the 500-line limit on server files. `npm run build` runs it. It does not replace checking behaviour.

## Interface languages

The interface comes in Chinese and English (A45), more can be added; everything the model reads from Jarvy is English.

- `web/i18n/`: `en/` is the reference dictionary and `zh/` covers the same keys, each a folder of parts by area (common, settings, chat, threads, bot, npc) that its `index.ts` puts together; a key lives in one part, and every language has the same parts. `keys.ts` derives `Key`, `Part` and `Shape` from the reference (so a missing, extra or wrongly shaped key fails `tsc`), and `index.tsx` holds the current language, `t()`, `rich()`, `useLocale()` and the formatters `formatDate()`, `formatClock()`, `formatDay()` and `formatNumber()` (dates, times and numbers follow the interface language, not a fixed zh-CN).
- The language is picked from the browser on first visit (`zh*` → Chinese, anything else English), switchable in 设置 → 通用 and on the login page, and remembered in this browser. `<html lang>` follows it.
- Strings are resolved while rendering, never at module top level; a module-level constant holds a key. The app root subscribes through `useLocale()`, so switching re-renders in place and open dialogs and panes stay; a `memo` component that shows text (Markdown) calls `useLocale()` itself, since memo skips that re-render. Styles and selectors never match translated text (`aria-label`); they use classes or `data-slot`.
- `scripts/check-i18n.mjs` (part of `check:architecture`) checks key parity, placeholders and empty values, and scans every component for Chinese text (the vendored `components/` copies are translated where they are used).
- Failures: `web/errors.ts` words the server's failure codes; `errorText(reason, fallback)` is what a component shows for a failed request, `statusError(status)` for a Bot's run error. A component never shows a server message it did not get through these.
- Previews: the server sends a message excerpt as its content and quotes (`lastMessage`, `replyTo`, a thread's `root`; content `""` is attachments only), and `previewText()` in `channel/quotes.tsx` words it. A History summary comes as its text, tool steps and image count, worded by the activity timeline. Titles the server stores carry no interface words: an untitled DM is `""`, an attachment-only first message gives its file's name, quotes are `"passage"`, a DM between two Bots is `A · B`. A new Bot's default name comes from `freeBotName()` in `members.ts`.
- What people write — Bot personas, notices, summaries, messages — is never translated.
- Little text on screen: a heading, an icon or the group a row sits in already says what it is, so no subtitle, page description or empty-state second line repeats it. A second line stays only for what the layout can't show: a safety warning, a side effect (an @ adding someone to the channel, files kept when a Bot is deleted), a limit (the 5-minute minimum) or a step in a flow.
- Menus in dialogs: a modal dialog locks scrolling (wheel and touch) outside itself and clips what sticks out. A Select or menu brings a lock of its own and scrolls anyway; a non-modal popover doesn't, so one that can open in a dialog portals into it and takes it as its collision boundary (`BotModelControls` finds it through `[data-slot=dialog-content]`; a native `<dialog>` likewise, see `channel/SectionSelect.tsx`).

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
- SSE subscriptions belong to services; encoding, auth and closing the stream belong to the API, in one place (`api/event-stream.ts`): a route only says what it subscribes to and what it sends first.

The activity timeline is a read-only composition: the activity route → `BotService.activity` → `ChatService.sentActivity` and `Memory.timeline` → their repositories. It is not an eighth Bot part and has no storage of its own.
