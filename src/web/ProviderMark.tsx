import type { ModelConnection } from "../contract/models";
import { t } from "./i18n";
import { providerLogo } from "./provider-logos";

/** A provider's badge: its brand's logo for a built-in provider that has one (`provider` is its ID), else the first
 * letter of its name. */
export function ProviderMark({ name, provider }: { name: string; provider?: string }) {
  const logo = providerLogo(provider);
  return logo ? <span className="jv-provider-mark" data-logo="" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }}/>
    : <span className="jv-provider-mark" aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? "?"}</span>;
}
export function connectionStatus(connection: Pick<ModelConnection, "configured" | "authType">) {
  const oauth = connection.authType === "oauth";
  return connection.configured ? { ok: true, label: t(oauth ? "status.signedIn" : "status.configured") } : { ok: false, label: t(oauth ? "status.signedOut" : "status.notConfigured") };
}
