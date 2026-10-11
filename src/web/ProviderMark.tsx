import type { ModelConnection } from "./api";

/** Letter badge used where a provider has no logo of its own. */
export function ProviderMark({ name }: { name: string }) {
  return <span className="jv-provider-mark" aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? "?"}</span>;
}
export function connectionStatus(connection: Pick<ModelConnection, "configured" | "authType">) {
  const oauth = connection.authType === "oauth";
  return connection.configured ? { ok: true, label: oauth ? "已登录" : "已配置" } : { ok: false, label: oauth ? "未登录" : "未配置" };
}
