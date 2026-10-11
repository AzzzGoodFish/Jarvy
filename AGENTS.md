# Working on Jarvy

Read [docs/index.md](docs/index.md) and the [engineering principles](docs/engineering-principles.md) before changing code, then the architecture docs for the area you touch. Decisions and their reasons are in the [ADR log](docs/decisions.md); code comments cite them as `A01`–`A41`.

## Hard rules

- **File size.** No source file over 500 lines. When a file gets close, split along a real responsibility.
- **Layers.** The server is `api → service → infra`, with `shared` for plain contracts:
  - `api` does not import `infra`; `service` does not import `api`; `infra` does not import `service`, `api` or `application`; `shared` imports only `shared`.
  - `@earendil-works/*` (Pi) is imported only in `infra/pi`; `node:sqlite` only in `infra/storage`.
  - `src/web` never imports `src/server`.
  - `npm run build` runs `scripts/check-boundaries.mjs`, which enforces the above.
- **No speculative code.** No defensive layers, retries, fallbacks or abstractions without a real case. Pi's defaults for requests, retries, compaction and cancellation stay in charge (A16).
- **Delete, don't shim.** Internal paths are replaced outright: no compatibility layers, deprecated wrappers or dual writes. Data migrations and the `/api/*` contract are kept and versioned.
- **People and Bots are the same at the upper layers.** Routing, policy and the inbox treat them alike; they differ only in how each responds (A41).
- **Ask before adding.** A new boundary, policy, user-visible behaviour or change to the Bot prompt is described to the maintainer first — the real scenario, what the user sees, the trade-offs — and built after it is agreed.

## Verifying a change

There are no unit tests. Verify with:

1. `npm run build` — type checks, layer check and the production frontend build.
2. A real run against an isolated data directory (`--data-dir`, a separate port), using a fake model endpoint for routine flows. Never test against a data directory someone uses.
3. For UI changes, browser screenshots in light and dark themes and at 390 px width.
4. For schema changes, also migrate a copy of an existing database (credentials removed, pending work cancelled) and check `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

## Frontend

- Reuse shadcn/ui components. Colours, type, radii and shadows come from `styles/tokens.css` (`--ui-*`); use them instead of literal values. `shell.css` holds the app frame and shared controls, `rich-text.css` message Markdown, `attachments.css` files and previews; feature styles go in `jarvy.css`, `channels.css`, `threads.css` or `floating-bot.css`.
- UI copy is short and plain (for example 「暂无公告」). The UI shows what the user needs to act; no development notes, sources or future plans.

## Documentation

- Docs are in English and describe the current state. Process history, verification logs and progress notes do not go into the repository.
- A design change updates the relevant architecture doc and adds or amends an ADR (decision, why, consequences, what it supersedes).
- No local paths, ports, user names, credentials or private chat references in code, comments or docs.
