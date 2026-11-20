import { join } from "node:path";
import type { ConnectorProvider, ManagedClientInfo } from "../../../contract/connectors.js";
import type { ConnectorCatalogMeta } from "../../shared/connector.js";

export interface ManagedClient { clientId: string; clientSecret: string }

export const CALLBACK_PATH = "/api/connectors/oauth/callback";

/** Deployment settings for connectors (A102), read from the process environment (`.env` in the data directory fills in
 * what the environment lacks). Variable names come from the registered vendor adapters, never duplicated here. */
export class ConnectorEnv {
  private readonly vars = new Map<ConnectorProvider, readonly [string, string]>();

  constructor(
    catalog: readonly ConnectorCatalogMeta[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const item of catalog) if (item.envVars) this.vars.set(item.id, item.envVars);
  }

  isManaged(provider: ConnectorProvider): boolean { return this.vars.has(provider); }

  variables(provider: ConnectorProvider): string[] { return [...(this.vars.get(provider) ?? [])]; }

  client(provider: ConnectorProvider): ManagedClient | null {
    const pair = this.vars.get(provider);
    if (!pair) return null;
    const clientId = this.env[pair[0]]?.trim(), clientSecret = this.env[pair[1]]?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  managedInfo(provider: ConnectorProvider): ManagedClientInfo | null {
    const pair = this.vars.get(provider);
    if (!pair) return null;
    return { ready: Boolean(this.client(provider)), variables: [...pair] };
  }

  /** The address Jarvy is opened at, when the deployment fixes it (`JARVY_PUBLIC_URL`): its origin, no path. */
  publicUrl(): string | null {
    const raw = this.env.JARVY_PUBLIC_URL?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch { return null; }
  }

  /** Every client secret held here, for the Masker. */
  secrets(): { name: string; value: string }[] {
    const found: { name: string; value: string }[] = [];
    for (const [, secretName] of this.vars.values()) {
      const secret = this.env[secretName]?.trim();
      if (secret) found.push({ name: secretName, value: secret });
    }
    return found;
  }
}

/** Reads `<dataDir>/.env` into the process environment (variables already set win), then returns the settings. */
export function loadConnectorEnv(dataDir: string, catalog: readonly ConnectorCatalogMeta[]): ConnectorEnv {
  try { process.loadEnvFile(join(dataDir, ".env")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("[connectors] could not read .env", { error: error instanceof Error ? error.message : String(error) });
  }
  return new ConnectorEnv(catalog);
}
