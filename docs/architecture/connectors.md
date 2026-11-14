# Connectors

[Index](../index.md) · [Secrets](secrets.md) · [Tools and prompt](tools-and-prompt.md)

External service integrations exposed uniformly to Bots through the `chat` gateway (A94). A connector hides whether the underlying driver is a remote MCP server (`remote_mcp`) or a built-in service adapter (`builtin`).

## Storage and security (v33)

- `connectors`: id, owner, `slug` (unique per owner), display name, `kind`, `provider`, non-secret configuration (`config_json`), `safety` (`read_only` | `confirm_writes` | `auto`), `enabled`, `status` (`disconnected` | `connected` | `needs_auth` | `error`), `status_detail`, and cached `tools_json`.
- `connector_credentials`: one row per connector, sealed under the master key with AES-256-GCM (`connector:<id>`). Holds static request headers, OAuth client configuration, and OAuth tokens/discovery state.
- `connector_grants`: which Bots may use a connector.
- `connector_uses`: audit log of every tool call (`ok` | `error` | `denied`), outliving connector deletion.
- Every secret held in `connector_credentials` is registered with `SecretService`'s `Masker`, so tokens and headers are redacted from tool outputs, live streams and chat batches.

## Drivers (`infra/pi/mcp.ts` and `infra/connectors/`)

- **Remote HTTP MCP (`kind: "remote_mcp"`)**:
  - Built on `@earendil-works/pi-mcp` (`StreamableHttpTransport`, `McpClient`, `@earendil-works/pi-mcp/oauth`).
  - Supports `none`, static `headers`, and `oauth` (PKCE, dynamic client registration, token refresh serialized per connector).
  - Curated presets (`Linear`, `Notion`, `Figma`, plus `Custom MCP`) appear in Settings → Connectors.
- **Built-in SaaS adapters (`kind: "builtin"`, `infra/connectors/{github,gmail,slack,builtin}.ts`)**:
  - **GitHub**: `search_issues`, `list_issues`, `get_issue`, `create_issue`, `create_comment`; supports Personal Access Token (`headers`) or GitHub OAuth App (`oauth`).
  - **Gmail**: `search_messages`, `get_message`, `create_draft`, `send_email`; uses owner-supplied Google Cloud OAuth Client ID & Secret with browser OAuth and automatic refresh token renewal.
  - **Slack**: `list_channels`, `read_messages`, `read_thread`, `send_message`; supports Bot/User Token (`headers`) or Slack OAuth v2 (`oauth`).
- **OAuth callback**: Public route `GET /api/connectors/oauth/callback` is registered before session cookie middleware (because `SameSite=Strict` cookies are omitted on cross-site OAuth redirects) and matched by the in-flight `state` token; manual callback URL pasting is supported as a fallback.

## Bot tools and safety

- `connectors.list`: returns all enabled connectors with `slug`, `status`, `safety`, tool summaries, and `granted`.
- `connectors.describe`: returns full input schemas for a granted connector.
- `connectors.call`: invokes a tool on a granted connector:
  - `read_only`: rejects write tools (`connector_read_only`).
  - `confirm_writes` (default): posts an in-chat confirmation card (`connectorWrite`) showing the connector, tool and masked arguments before executing; requires a person in the chat.
  - `auto`: executes directly.
- `connectors.request`: posts an in-chat `connectorAuth` card when a connector is not granted or needs authorization; OAuth completion settles the card automatically and grants access to the Bot.
