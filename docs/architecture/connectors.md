# Connectors

[Index](../index.md) · [Secrets](secrets.md) · [Tools and prompt](tools-and-prompt.md)

External service integrations exposed uniformly to Bots through the `chat` gateway (A102). Each provider is a self-contained adapter module behind a shared connector base, hiding whether a connector speaks Streamable HTTP MCP (`remote_mcp`) or a built-in REST/OAuth adapter (`builtin`).

## Architecture: shared base + per-vendor modules

- **Shared base**:
  - `server/shared/connector.ts`: driver contract (`ConnectorDriver`) and safe write classification (`isWriteTool`).
  - `server/service/connectors.ts`, `connectors-batch.ts`, `connectors-oauth.ts`, `connectors-requests.ts`: vendor-agnostic lifecycle, encrypted credentials, `Masker` redaction, ephemeral preset OAuth/token flows, per-Bot grants, pure in-chat grant/write/batch confirmation cards, and audit logs.
  - `server/infra/pi/mcp.ts`: generic Streamable HTTP MCP transport built on `@earendil-works/pi-mcp`.
  - `server/infra/connectors/adapter.ts` & `registry.ts`: `ConnectorAdapter` contract and single `ConnectorRegistry` dispatching all provider calls without branching in services.
- **Per-vendor modules (`server/infra/connectors/providers/`)**:
  - `github.ts` (`remote_mcp`): connects to GitHub's official hosted Streamable HTTP MCP server (`https://api.githubcopilot.com/mcp/`) using either a deployment GitHub OAuth App or a Personal Access Token (PAT) fallback — both authenticate as a GitHub Bearer token and expose the full dynamic GitHub MCP toolset (repositories, branches, files, issues, pull requests, releases, search).
  - `gmail.ts` (`builtin`): `search_messages`, `get_message`, `create_draft`, `send_email`. Web OAuth (deployment Google Cloud OAuth client, `prompt=select_account consent`) with automatic refresh-token renewal and RFC 2047 MIME encoding.
  - `linear.ts` (`remote_mcp`): curated preset for Linear's official remote MCP (`https://mcp.linear.app/mcp`) with dynamic OAuth registration.
  - `custom-mcp.ts` (`remote_mcp`): arbitrary Streamable HTTP MCP server (`oauth`, static `headers`, or `none`).

## Storage and security (v34–v35)

- `connectors`: id, owner, `slug` (unique per owner), display name, `kind`, `provider`, non-secret config (`config_json`, storing `url`, `authKind`, and persistent `accountLabel`), `enabled`, `status` (`disconnected` | `connected` | `needs_auth` | `error`), `status_detail` (account handle/email when connected, masked error otherwise), and cached `tools_json`. Multiple accounts may be connected for the same preset provider (each gets its own row, unique `slug`, optional display name and independent Bot grants).
- `connector_credentials`: one row per connector, sealed under the master key with AES-256-GCM (`connector:<id>`). Preset connector credentials are **immutable**: to rotate a token or sign in again, disconnect the connection (deleting the row and its grants) and add it fresh. Editing a Custom MCP's URL or credentials revokes all Bot grants and expires pending cards.
- `connector_grants`: per-Bot access grants (`scope`: `'always'` until revoked, or `'once'` tied to `run_id` until that Bot run ends, v35). Newly connected connectors start with no Bot grants.
- `connector_uses`: audit log (`ok` | `error` | `denied`), outliving connector deletion.
- Every connector secret and deployment client secret is registered in `SecretService`'s `Masker`.

## Bot tools and two-layer authorization

- `connectors.list`: returns enabled connectors with `slug`, `name`, `account` (when connected), `status`, `toolCount`, `tools` (compact when a connector has > 8 tools; optional `query` filter), `granted` and `until` (for one-run grants).
- `connectors.describe`: returns full input schemas (and `account`) for a granted connector, filterable by exact `tool` or keyword `query`.
- **Layer 1 — Connector access (`connectors.request`)**: posts a pure in-chat `connectorAuth` grant card for one or multiple already-connected connectors (up to 20 via `connectors`), capturing each connector's displayed `account`, active credential fingerprint, and requesting Bot `runId`. The owner synchronously chooses **Decline**, **This time only** (bound strictly to the requesting run, never falling back to a later run) or **Always allow** (optionally unchecking individual connectors in a batch request) — matching `secrets.request` (A52). Disconnected connectors are connected or re-added in Settings → Connectors rather than inside chat cards.
- **Layer 2 — Write confirmation (`connectors.call` / `connectors.batch`)**: invokes one or more tools on a granted connector:
  - Read tools (`readOnly === true && destructive !== true`) run directly once the connector is granted.
  - Every other tool (including remote MCP tools that omit `readOnly`) is treated as a write tool and **always** pauses on an in-chat confirmation card (`connectorWrite`, editable, for `connectors.call`; `connectorBatchWrite`, up to 50 items per batch, for `connectors.batch`). On a batch card, identical fields across all write items are surfaced once at the top (`commonFields`), every item's varying fields remain inspectable losslessly, and the owner can uncheck individual items before confirming once. Approved items execute sequentially with live credential/grant re-checks, per-item `connector_uses` audit rows, and structured per-item `{ ok / error / skipped }` results.
- **Live pending-card expiration**: disconnecting, deleting, disabling, or failing a connector (or revoking a Bot's grant) immediately expires every live pending `connectorAuth`, `connectorWrite`, and `connectorBatchWrite` card bound to it — persisting `expiredReason` (`connector_disconnected` | `connector_revoked`), updating open chats via SSE, and waking the waiting Bot with `question_expired` so no run is stranded.

## Deployment OAuth settings

Built-in OAuth clients belong to the deployment, read from `process.env` and `<data dir>/.env` (`process.loadEnvFile`; existing environment variables win). Variable names are declared on each vendor adapter and loaded by `infra/connectors/client-env.ts`; secrets stay in memory and are registered with `Masker`.

| Variable | Meaning |
| --- | --- |
| `JARVY_GITHUB_CLIENT_ID`, `JARVY_GITHUB_CLIENT_SECRET` | GitHub OAuth App (optional; GitHub also accepts a Personal Access Token) |
| `JARVY_GMAIL_CLIENT_ID`, `JARVY_GMAIL_CLIENT_SECRET` | Google Cloud OAuth client (Gmail API) |
| `JARVY_PUBLIC_URL` | Optional origin (`https://host:port`) that fixes the OAuth callback to `<JARVY_PUBLIC_URL>/api/connectors/oauth/callback` |

## Interface (Settings → Connectors)

- Curated presets (`GitHub`, `Gmail`, `Linear`) stay available in the lower section so multiple accounts (or scoped tokens) can be connected for the same provider. Each row shows `Connect` (or `Add account` with the connected count), opens an ephemeral inline drawer with an optional label for token sign-in, and **never creates a database row until authorization or token verification succeeds**. Gmail requests `prompt=select_account consent` so additional Google accounts can be chosen cleanly.
- Connected items show Bot grants (tagging one-run grants as `This time only`) by default; the full tool list (searchable above 8 tools), usage log, preset account settings (rename and identifier) and Custom MCP connection settings stay collapsed inside secondary disclosures.
