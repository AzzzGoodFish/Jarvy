# Models and credentials

[Index](../index.md) · [Runtime](runtime.md) · [Storage](storage.md)

## Structure

```text
provider type (provider_name, may repeat)
  ├─ connection A (connectionId, immutable key) → credential A + models
  └─ connection B (connectionId, immutable key) → credential B + models
Bot selection → one connectionId + one modelId + thinkingLevel
```

One provider can have several connections — say a personal and a work Codex account (A09). `provider_name` is the driver, not a key. A Bot's runtime is given only its selected model and that connection's credential; switching keeps the same session.

| Layer | Fields |
| --- | --- |
| Connection | connectionId, owner, provider_name, display name, built-in or custom, auth type, base URL, default API protocol, optional headers |
| Credential | one per connection: type and its secret data, updated time |
| Model | `(connectionId, modelId)`, name, optional API override, reasoning, text/image input, context window, max tokens, thinking level map, thinking format, compat, cost, optional headers |
| Bot selection | connectionId, modelId, thinkingLevel (`auto` or a level) |

```ts
type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number /* plus provider-specific fields */ };
```

## Storage and safety

- SQLite holds model configuration and credentials. They are loaded into an in-memory model runtime and credential store; no `auth.json` / `models.json` copies.
- The browser gets non-secret configuration and a configured flag only. Keys, tokens and headers carrying auth are never returned, logged, put in XML, prompts or indexes.
- A new connection and its key are saved atomically. An empty key field on edit means "unchanged"; deleting is an explicit action.
- A connection a Bot uses can't be deleted. A deleted Bot uses none: deleting it clears its link, and deleting a connection also clears the links that deleted Bots kept from before.
- Keys are stored literally; Pi Web's `!shell-command` and environment-variable expansion are not supported, so a web form can never run host commands.

## Pi adapter

- Pi's credential store asks by native provider ID; Jarvy answers with the **current** connection's credential. Provider IDs such as `openai-codex` are not renamed, because protocol code may depend on them.
- `ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false })` is the injection point.
- OAuth login does not need a running Bot. Refreshes are written back to the same connection and serialised per connection, so an old refresh token never overwrites a new one and two connections never overwrite each other.
- Login uses Pi's native flows: browser or device code for Codex, ChatGPT OAuth for `openai` (manual entry takes the full callback URL). `ModelRuntime.login` gets a persistent per-data-directory device ID (v8). OAuth records keep provider extras such as `clientId` and `scopes`.
- The model catalog is chat-only: providers with only image or classifier models are hidden.
- The catalog (`infra/pi/catalog.ts`, A49) is the one bundled with Pi, overlaid with `https://pi.dev/api/models` when that is newer: an entry replaces the bundled one with the same ID or adds a model, only for providers and protocols the SDK knows. It is checked when the server starts and then at most every 4 hours (ETag, 15 s timeout), kept in `<data>/pi/models.json` and used offline; a failed check keeps what was there. `PI_OFFLINE=1`, Pi's own switch, stops the checks. The provider list, a provider's models, a connection's catalog and auto-configuration all read it; requests still go through Pi with the connection's own model settings.

## Settings UI

- Built with shadcn/ui, following Pi Web's provider and model editing flow. Providers are grouped as custom API / subscription / API key. There is no connection test and no model check (A10).
- **Provider logos** (`provider-logos/`): a built-in provider shows its brand's logo — in the picker, the connection list and the editor header — from lobe-icons SVGs copied into the repo (MIT, `licenses/LOBE-ICONS-MIT.txt`), the colour version where a brand has one, single-colour logos in `currentColor`; Kimi and Fireworks use the single-colour version because their colour logos read poorly on one theme. `BRANDS` maps Pi's provider IDs to them; variants share a brand (the Qwen Token Plans, Moonshot CN, OpenAI's subscriptions). An ID with no logo (Radius, a provider a later Pi adds) and custom providers keep the first letter. Nothing is fetched from outside.
- Custom endpoints can fetch their model list (OpenAI, Anthropic, Gemini protocols). Models are edited as expandable cards.
- **Bot model menu** (in Bot info): models grouped by connection, searchable above eight, so same-named models of two accounts stay apart. Thinking levels follow Pi's supported levels plus `auto`.
- **`auto`** is an intent, stored as is; the adapter resolves it to a real level (Pi's default, medium) and the API reports `effectiveThinkingLevel`, shown as `auto · medium` (A17). Choosing applies immediately; changing only the level calls `setThinkingLevel`.
- `/api/model-options` lists the owner's models, grouped, with thinking capabilities; no secrets, no agent start, no model request.
- **通用** (`General.tsx`): the interface language and the theme, both remembered in this browser (A45).
- **关于** (`About.tsx`): the README's one line, the version, and links to the repository, the npm package, the licence and the third-party notice at that version's tag — all read from `package.json` at build time.

## Auto-configuration

`POST /api/model-autoconfig` suggests a model's specs from the model catalog (A49): the one that ships with Pi, overlaid with pi.dev's newer entries. There is no catalog table: upgrading Pi upgrades the bundled part.

- **Matching** (`infra/pi/autoconfig.ts`): exact IDs and IDs without namespace or date suffix rank together; substrings are a fallback. The model's own vendor scores highest; with several vendors the provider named after the vendor, or the only one on the same protocol, wins, otherwise the user chooses. Reseller-only matches take the most complete entry and say so; no match lists similar IDs.
- **Filled in**: reasoning, image input, context and output limits, cost, thinking level map. Thinking format and compat are filled only when the catalog's protocol matches the connection's. ID, a custom name, headers and API override are untouched.
- The suggestion stays in the open card until saved; the source is not stored.
- **compat** is stored in `connection_models.config_json` as a JSON object of at most 16 KB (its `thinkingFormat` is stored separately). At run time: built-in provider compat < saved compat < the thinking-format field. Built-in connections read compat from the current SDK, so an old snapshot never overrides an upgrade.
- **Thinking settings**: a thinking format menu (Chat Completions only) and a table of seven levels, each "supported (default) / not supported / supported with a given value"; `xhigh` and `max` need an explicit value, matching Pi's `getSupportedThinkingLevels`.
- Known limitation: the same protocol does not mean a third-party gateway accepts vendor extensions. A custom Anthropic gateway rejected the `supportsMidConvoEffort` messages that auto-configuration copied; turning that compat flag off fixes it. Auto-configuration does not adjust this for custom connections.
