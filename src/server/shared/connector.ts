import type {
  ConnectorAuthKind, ConnectorKind, ConnectorProvider, ConnectorTool, ManagedClientInfo,
} from "../../contract/connectors.js";

export const CONNECTOR_SLUG = /^[a-z][a-z0-9_-]{0,47}$/;

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

export type ConnectorProbeResult =
  | { outcome: "connected"; tools: ConnectorTool[]; snapshot?: McpOAuthSnapshot; accountLabel?: string }
  | { outcome: "needs_auth"; message: string; snapshot?: McpOAuthSnapshot }
  | { outcome: "error"; message: string };

export type ConnectorCallResult =
  | { outcome: "ok"; text: string; images: { data: string; mimeType: string }[]; isError: boolean; snapshot?: McpOAuthSnapshot }
  | { outcome: "needs_auth"; message: string; snapshot?: McpOAuthSnapshot }
  | { outcome: "error"; message: string };

export type ConnectorStartOAuthResult =
  | { outcome: "redirect"; authUrl: string; state: string; snapshot: McpOAuthSnapshot }
  | { outcome: "authorized"; snapshot: McpOAuthSnapshot };

export interface ConnectorCatalogMeta {
  id: ConnectorProvider;
  name: string;
  kind: ConnectorKind;
  defaultUrl: string;
  authMethods: readonly ConnectorAuthKind[];
  envVars?: readonly [string, string];
}

export interface ConnectorDriver {
  catalog(): readonly ConnectorCatalogMeta[];
  meta(provider: ConnectorProvider): ConnectorCatalogMeta;
  hasProvider(provider: string): provider is ConnectorProvider;
  probe(options: {
    provider: ConnectorProvider;
    url: string;
    authKind: ConnectorAuthKind;
    headers?: Record<string, string>;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
  }): Promise<ConnectorProbeResult>;
  callTool(options: {
    provider: ConnectorProvider;
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
  }): Promise<ConnectorCallResult>;
  startOAuth(options: {
    provider: ConnectorProvider;
    url: string;
    oauth?: McpOAuthSnapshot;
    clientId?: string;
    clientSecret?: string;
    redirectUrl: string;
    signal?: AbortSignal;
  }): Promise<ConnectorStartOAuthResult>;
  completeOAuth(options: {
    provider: ConnectorProvider;
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

/** Provider metadata needed by storage to expose managed client status and auth methods cleanly. */
export interface ConnectorRuntimeInfo {
  authMethods(provider: ConnectorProvider): ConnectorAuthKind[];
  managedClient(provider: ConnectorProvider): ManagedClientInfo | null;
  secrets(): { name: string; value: string }[];
}

/** A tool is treated as a write/mutation unless explicitly annotated readOnly=true and not destructive (MCP safety default, A102). */
export function isWriteTool(tool: ConnectorTool): boolean {
  return !(tool.readOnly === true && tool.destructive !== true);
}
