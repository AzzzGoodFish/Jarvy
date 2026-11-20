import type { ConnectorAuthKind, ConnectorKind, ConnectorProvider } from "../../../contract/connectors.js";
import type {
  ConnectorCallResult, ConnectorCatalogMeta, ConnectorProbeResult, ConnectorStartOAuthResult, McpOAuthSnapshot,
} from "../../shared/connector.js";

export interface AdapterProbeInput {
  url: string;
  authKind: ConnectorAuthKind;
  headers?: Record<string, string>;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
  redirectUrl: string;
}

export interface AdapterCallInput extends AdapterProbeInput {
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AdapterStartOAuthInput {
  url: string;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
  redirectUrl: string;
  signal?: AbortSignal;
}

export interface AdapterCompleteOAuthInput extends AdapterStartOAuthInput {
  code: string;
  iss?: string;
}

/** Self-contained vendor adapter contract (A102): each provider module owns its metadata, env requirements,
 * OAuth handshake and tool execution so adding or maintaining a vendor stays inside its own file. */
export interface ConnectorAdapter extends ConnectorCatalogMeta {
  readonly id: ConnectorProvider;
  readonly name: string;
  readonly kind: ConnectorKind;
  readonly defaultUrl: string;
  readonly authMethods: readonly ConnectorAuthKind[];
  readonly envVars?: readonly [string, string];
  probe(input: AdapterProbeInput): Promise<ConnectorProbeResult>;
  callTool(input: AdapterCallInput): Promise<ConnectorCallResult>;
  startOAuth(input: AdapterStartOAuthInput): Promise<ConnectorStartOAuthResult>;
  completeOAuth(input: AdapterCompleteOAuthInput): Promise<McpOAuthSnapshot>;
}
