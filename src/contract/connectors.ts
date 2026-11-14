/** External service connectors (A94): remote MCP servers and built-in adapters exposed uniformly to Bots. */

export type ConnectorKind = "remote_mcp" | "builtin";
export type ConnectorProvider = "custom_mcp" | "linear" | "notion" | "figma" | "github" | "gmail" | "slack";
export type ConnectorAuthKind = "none" | "headers" | "oauth";
export type ConnectorSafety = "read_only" | "confirm_writes" | "auto";
export type ConnectorStatus = "disconnected" | "connected" | "needs_auth" | "error";

export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface ConnectorGrant {
  botId: string;
  grantedAt: number;
}

export interface ConnectorUse {
  id: number;
  connectorSlug: string;
  botId: string;
  at: number;
  toolName: string;
  outcome: "ok" | "error" | "denied";
  detail: string;
}

/** A connector as the interface sees it: credentials never leave the server. */
export interface Connector {
  id: string;
  slug: string;
  name: string;
  kind: ConnectorKind;
  provider: ConnectorProvider;
  url: string;
  authKind: ConnectorAuthKind;
  headerNames: string[];
  oauthClientId: string | null;
  hasClientSecret: boolean;
  safety: ConnectorSafety;
  enabled: boolean;
  status: ConnectorStatus;
  statusDetail: string;
  readable: boolean;
  tools: ConnectorTool[];
  grants: ConnectorGrant[];
  uses: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorPreset {
  id: ConnectorProvider;
  name: string;
  kind: ConnectorKind;
  url: string;
  authKind: ConnectorAuthKind;
}

export interface ConnectorOAuthState {
  phase: "idle" | "waiting" | "completed" | "cancelled" | "error";
  authUrl?: string;
  redirectUri?: string;
  error?: string;
}
