# Connectors

[Index](../index.md) · [Secrets](secrets.md) · [Tools and prompt](tools-and-prompt.md)

External service integrations exposed uniformly to Bots through the `chat` gateway (A99). Each provider is a self-contained adapter module behind a shared connector base, hiding whether a connector speaks Streamable HTTP MCP (`remote_mcp`) or a built-in REST/OAuth adapter (`builtin`).

## Architecture: shared base + per-vendor modules

- **Shared base**:
  - `server/shared/connector.ts`: driver contract (`ConnectorDriver`), safe write classification (`isWriteTool`), and canonical tool-definition fingerprinting (`toolDefinitionHash`).
  - `server/service/connectors.ts` & `connectors-oauth.ts`: vendor-agnostic lifecycle, encrypted credentials, `Masker` redaction, ephemeral preset OAuth/token flows, per-Bot grants, write confirmation cards, and audit logs.
  - `server/infra/pi/mcp.ts`: generic Streamable HTTP MCP transport built on `@earendil-works/pi-mcp`.
  - `server/infra/connectors/adapter.ts` & `registry.ts`: `ConnectorAdapter` contract and single `ConnectorRegistry` dispatching all provider calls without branching in services.
- **Per-vendor modules (`server/infra/connectors/providers/`)**:
  - `github.ts` (`remote_mcp`): connects to GitHub's official hosted Streamable HTTP MCP server (`https://api.githubcopilot.com/mcp/`) using either a deployment GitHub OAuth App or a Personal Access Token (PAT) fallback — both authenticate as a GitHub Bearer token and expose the full dynamic GitHub MCP toolset (repositories, branches, files, issues, pull requests, releases, search).
  - `gmail.ts` (`builtin`): `search_messages`, `get_message`, `create_draft`, `send_email`. Web OAuth (deployment Google Cloud OAuth client) with automatic refresh-token renewal and RFC 2047 MIME encoding.
  - `linear.ts` (`remote_mcp`): curated preset for Linear's official remote MCP (`https://mcp.linear.app/mcp`) with dynamic OAuth registration.
  - `custom-mcp.ts` (`remote_mcp`): arbitrary Streamable HTTP MCP server (`oauth`, static `headers`, or `none`).

## Storage and security (v34)

- `connectors`: id, owner, `slug` (unique per owner), display name, `kind`, `provider`, non-secret config (`config_json`), `enabled`, `status` (`disconnected` | `connected` | `needs_auth` | `error`), `status_detail` (account handle/email when connected, masked error otherwise), and cached `tools_json`.
- `connector_unconfirmed_tools`: per-connector write tools exempted from in-chat confirmation, stored with `definition_hash` (`toolDefinitionHash`). If a remote server changes a tool's description, annotations or schema, the approval automatically expires.
- `connector_credentials`: one row per connector, sealed under the master key with AES-256-GCM (`connector:<id>`).
- `connector_grants`: per-Bot access grants.
- `connector_uses`: audit log (`ok` | `error` | `denied`), outliving connector deletion.
- Every connector secret and deployment client secret is registered in `SecretService`'s `Masker`.

## Bot tools and write confirmation

- `connectors.list`: returns enabled connectors with `slug`, `status`, `toolCount`, `tools` (compact when a connector has > 8 tools; optional `query` filter) and `granted`.
- `connectors.describe`: returns full input schemas for a granted connector, filterable by exact `tool` or keyword `query`.
- `connectors.call`: invokes a tool on a granted connector:
  - Read tools (`readOnly === true && destructive !== true`) always run directly.
  - Any other tool (including remote MCP tools that omit `readOnly`) is treated as a write tool and posts an editable in-chat confirmation card (`connectorWrite`). Edits are validated against `inputSchema` (covering all schema properties, not only fields the Bot passed). The primary button's menu offers "Confirm / Send & don't ask again", recording `(tool_name, definition_hash)` so only explicitly exempted tools bypass future confirmation.
- `connectors.request`: posts an in-chat `connectorAuth` card when a connector is not granted or needs sign-in; OAuth completion settles the card automatically and grants access to the Bot.

## Deployment OAuth settings

Built-in OAuth clients belong to the deployment, read from `process.env` and `<data dir>/.env` (`process.loadEnvFile`; existing environment variables win). Variable names are declared on each vendor adapter and loaded by `infra/connectors/client-env.ts`; secrets stay in memory and are registered with `Masker`.

| Variable | Meaning |
| --- | --- |
| `JARVY_GITHUB_CLIENT_ID`, `JARVY_GITHUB_CLIENT_SECRET` | GitHub OAuth App (optional; GitHub also accepts a Personal Access Token) |
| `JARVY_GMAIL_CLIENT_ID`, `JARVY_GMAIL_CLIENT_SECRET` | Google Cloud OAuth client (Gmail API) |
| `JARVY_PUBLIC_URL` | Optional origin (`https://host:port`) that fixes the OAuth callback to `<JARVY_PUBLIC_URL>/api/connectors/oauth/callback` |

## Interface (Settings → Connectors)

- Unconnected curated presets (`GitHub`, `Gmail`, `Linear`) appear as clean one-line rows with a `Connect` button. Starting OAuth or entering a token happens in an ephemeral inline drawer and **never creates a database row until authorization or token verification succeeds**.
- Connected items show only Bot grants and any auto-approved write exceptions by default; the full tool list (searchable above 8 tools), usage log and Custom MCP connection settings stay collapsed inside secondary disclosures.
