/** External service connectors (A102): remote MCP servers and built-in vendor adapters exposed uniformly to Bots. */
import type { GrantScope } from "./secrets.js";

export type ConnectorKind = "remote_mcp" | "builtin";
export type ConnectorProvider = "github" | "gmail" | "linear" | "custom_mcp";
export type ConnectorAuthKind = "none" | "headers" | "oauth";
export type ConnectorStatus = "disconnected" | "connected" | "needs_auth" | "error";

export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  /** Set when read from storage: whether the tool may change external state (anything not explicitly readOnly). */
  write?: boolean;
}

export interface ConnectorGrant {
  botId: string;
  scope: GrantScope;
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

/** Deployment-managed OAuth client status for a built-in provider (read from env / `<dataDir>/.env`). */
export interface ManagedClientInfo {
  ready: boolean;
  variables: string[];
}

/** A configured connector as the interface sees it: credentials never leave the server. */
export interface Connector {
  id: string;
  slug: string;
  name: string;
  kind: ConnectorKind;
  provider: ConnectorProvider;
  url: string;
  authKind: ConnectorAuthKind;
  authMethods: ConnectorAuthKind[];
  headerNames: string[];
  oauthClientId: string | null;
  hasClientSecret: boolean;
  managedClient: ManagedClientInfo | null;
  enabled: boolean;
  status: ConnectorStatus;
  statusDetail: string;
  /** Persistent provider-verified account label (e.g. `@handle` or email), kept even if status later becomes `needs_auth`/`error`. */
  account: string;
  /** Short non-secret fingerprint of the connector's active credentials, used to bind in-chat approvals. */
  credFp: string;
  readable: boolean;
  tools: ConnectorTool[];
  grants: ConnectorGrant[];
  uses: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A curated connector offered in Settings → Connectors before it is connected. */
export interface ConnectorPreset {
  id: ConnectorProvider;
  name: string;
  kind: ConnectorKind;
  url: string;
  authMethods: ConnectorAuthKind[];
  managedClient: ManagedClientInfo | null;
}

export interface ConnectorOAuthState {
  phase: "idle" | "waiting" | "completed" | "cancelled" | "error";
  flowId?: string;
  connectorId?: string;
  authUrl?: string;
  redirectUri?: string;
  error?: string;
}
