import type { ConnectorProvider } from "../../../contract/connectors.js";
import type { ConnectorCatalogMeta, ConnectorDriver } from "../../shared/connector.js";
import { RemoteMcpTransport } from "../pi/mcp.js";
import type { ConnectorAdapter } from "./adapter.js";
import { createGitHubAdapter } from "./providers/github.js";
import { gmailAdapter } from "./providers/gmail.js";
import { createLinearAdapter } from "./providers/linear.js";
import { createCustomMcpAdapter } from "./providers/custom-mcp.js";

/** Single registry of every connector vendor module (A99): adding a provider means adding a module under `providers/`
 * and listing it here; service, storage and env layers read metadata from this registry instead of branching by name. */
export class ConnectorRegistry implements ConnectorDriver {
  private readonly adapters: Map<ConnectorProvider, ConnectorAdapter>;
  private readonly ordered: readonly ConnectorCatalogMeta[];

  constructor(list: readonly ConnectorAdapter[]) {
    this.adapters = new Map(list.map(adapter => [adapter.id, adapter]));
    this.ordered = list.map(({ id, name, kind, defaultUrl, authMethods, envVars }) => ({
      id, name, kind, defaultUrl, authMethods: [...authMethods], ...(envVars ? { envVars } : {}),
    }));
  }

  catalog(): readonly ConnectorCatalogMeta[] { return this.ordered; }

  hasProvider(provider: string): provider is ConnectorProvider {
    return this.adapters.has(provider as ConnectorProvider);
  }

  meta(provider: ConnectorProvider): ConnectorCatalogMeta {
    const found = this.adapters.get(provider);
    if (!found) throw new Error(`Unknown connector provider "${provider}"`);
    return found;
  }

  private get(provider: ConnectorProvider): ConnectorAdapter {
    const found = this.adapters.get(provider);
    if (!found) throw new Error(`Unknown connector provider "${provider}"`);
    return found;
  }

  probe: ConnectorDriver["probe"] = options => this.get(options.provider).probe(options);
  callTool: ConnectorDriver["callTool"] = options => this.get(options.provider).callTool(options);
  startOAuth: ConnectorDriver["startOAuth"] = options => this.get(options.provider).startOAuth(options);
  completeOAuth: ConnectorDriver["completeOAuth"] = options => this.get(options.provider).completeOAuth(options);
}

export function createConnectorRegistry(): ConnectorRegistry {
  const mcp = new RemoteMcpTransport();
  return new ConnectorRegistry([
    createGitHubAdapter(mcp),
    gmailAdapter,
    createLinearAdapter(mcp),
    createCustomMcpAdapter(mcp),
  ]);
}
