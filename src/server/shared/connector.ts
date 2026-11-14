import type { ConnectorAuthKind, ConnectorKind, ConnectorProvider, ConnectorTool } from "../../contract/connectors.js";

export const CONNECTOR_SLUG = /^[a-z][a-z0-9_-]{0,47}$/;

export interface ConnectorPresetDef {
  id: ConnectorProvider;
  name: string;
  kind: ConnectorKind;
  url: string;
  authKind: ConnectorAuthKind;
}

/** Curated connectors: built-in SaaS adapters (Driver C) and remote HTTP MCP presets (Driver A). */
export const CONNECTOR_PRESETS: readonly ConnectorPresetDef[] = [
  { id: "github", name: "GitHub", kind: "builtin", url: "https://api.github.com", authKind: "oauth" },
  { id: "gmail", name: "Gmail", kind: "builtin", url: "https://gmail.googleapis.com", authKind: "oauth" },
  { id: "slack", name: "Slack", kind: "builtin", url: "https://slack.com/api", authKind: "oauth" },
  { id: "linear", name: "Linear", kind: "remote_mcp", url: "https://mcp.linear.app/mcp", authKind: "oauth" },
  { id: "notion", name: "Notion", kind: "remote_mcp", url: "https://mcp.notion.com/mcp", authKind: "oauth" },
  { id: "figma", name: "Figma", kind: "remote_mcp", url: "https://mcp.figma.com/mcp", authKind: "oauth" },
  { id: "custom_mcp", name: "Custom MCP", kind: "remote_mcp", url: "", authKind: "oauth" },
];

export interface StoredConnectorCredentials {
  headers?: Record<string, string>;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
}

export interface McpOAuthSnapshot {
  serverUrl: string;
  clientInformation?: Record<string, unknown>;
  tokens?: {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
    id_token?: string;
  };
  tokensExpireAt?: number;
  codeVerifier?: string;
  oauthState?: string;
  discovery?: Record<string, unknown>;
}

export type McpProbeResult =
  | { outcome: "connected"; tools: ConnectorTool[]; snapshot?: McpOAuthSnapshot; accountLabel?: string }
  | { outcome: "needs_auth"; message: string; snapshot?: McpOAuthSnapshot }
  | { outcome: "error"; message: string };

export type McpCallResult =
  | { outcome: "ok"; text: string; images: { data: string; mimeType: string }[]; isError: boolean; snapshot?: McpOAuthSnapshot }
  | { outcome: "needs_auth"; message: string; snapshot?: McpOAuthSnapshot }
  | { outcome: "error"; message: string };

export type McpStartOAuthResult =
  | { outcome: "redirect"; authUrl: string; state: string; snapshot: McpOAuthSnapshot }
  | { outcome: "authorized"; snapshot: McpOAuthSnapshot };

export interface McpDriver {
  probe(options: {
    kind?: ConnectorKind;
    provider?: ConnectorProvider;
    url: string;
    authKind: ConnectorAuthKind;
    headers?: Record<string, string>;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
  }): Promise<McpProbeResult>;
  callTool(options: {
    kind?: ConnectorKind;
    provider?: ConnectorProvider;
    url: string;
    authKind: ConnectorAuthKind;
    headers?: Record<string, string>;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<McpCallResult>;
  startOAuth(options: {
    kind?: ConnectorKind;
    provider?: ConnectorProvider;
    url: string;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
    signal?: AbortSignal;
  }): Promise<McpStartOAuthResult>;
  completeOAuth(options: {
    kind?: ConnectorKind;
    provider?: ConnectorProvider;
    url: string;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
    code: string;
    iss?: string;
    signal?: AbortSignal;
  }): Promise<McpOAuthSnapshot>;
}

const WRITE_TOOL_NAME = /(?:^|[_-])(create|update|edit|delete|remove|destroy|drop|archive|unarchive|close|reopen|merge|push|commit|publish|post|send|reply|comment|assign|unassign|add|set|put|patch|write|upload|invite|kick|ban|approve|reject|submit|trigger|run|execute|move|rename|copy|duplicate)(?:[_-]|$)/i;

/** Whether a tool is treated as a write/mutation when the server did not annotate it explicitly. */
export function isWriteTool(tool: ConnectorTool): boolean {
  if (tool.readOnly === true && tool.destructive !== true) return false;
  if (tool.readOnly === false || tool.destructive === true) return true;
  return WRITE_TOOL_NAME.test(tool.name);
}
