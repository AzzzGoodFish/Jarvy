import type { ModelConnection } from "./api";
import { t } from "./i18n";

/** Letter badge used where a provider has no logo of its own. */
export function ProviderMark({ name }: { name: string }) {
  return <span className="jv-provider-mark" aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? "?"}</span>;
}
export function connectionStatus(connection: Pick<ModelConnection, "configured" | "authType">) {
  const oauth = connection.authType === "oauth";
  return connection.configured ? { ok: true, label: t(oauth ? "status.signedIn" : "status.configured") } : { ok: false, label: t(oauth ? "status.signedOut" : "status.notConfigured") };
}
