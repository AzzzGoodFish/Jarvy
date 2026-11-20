import { PlugIcon } from "lucide-react";
import type { ConnectorProvider } from "../../contract/connectors";

/** Brand marks for connectors (A102): 24×24 brand SVGs matching provider-logos, wrapped in .jv-provider-mark when badge=true. */
export function ConnectorMark({ provider, badge = false, className }: {
  provider: ConnectorProvider; badge?: boolean; className?: string;
}) {
  const icon = provider === "github" ? (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12Z"/>
    </svg>
  ) : provider === "gmail" ? (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M2 6.5V18a2 2 0 0 0 2 2h2V9.8L2 6.8V6.5Z"/>
      <path fill="#34A853" d="M18 20h2a2 2 0 0 0 2-2V6.5v.3l-4 3V20Z"/>
      <path fill="#FBBC04" d="M18 4.5v5.3l4-3V6a2 2 0 0 0-3.2-1.6L18 4.5Z"/>
      <path fill="#EA4335" d="M6 9.8V4.5l6 4.5 6-4.5v5.3l-6 4.5-6-4.5Z"/>
      <path fill="#C5221F" d="M2 6a2 2 0 0 1 3.2-1.6L6 4.5v5.3l-4-3V6Z"/>
    </svg>
  ) : provider === "linear" ? (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#5E6AD2" d="M.356 14.886a12.01 12.01 0 0 0 8.758 8.758L.356 14.886ZM.006 11.535 12.465 23.994c.666-.026 1.323-.107 1.964-.24L.246 9.571A12.04 12.04 0 0 0 .006 11.535Zm.842-3.972 15.589 15.589c.524-.216 1.03-.47 1.514-.76L1.608 6.049c-.29.484-.544.99-.76 1.514Zm2.168-3.373 16.794 16.794a12 12 0 1 0-16.794-16.794Z"/>
    </svg>
  ) : <PlugIcon className={className} aria-hidden="true"/>;

  return badge
    ? <span className="jv-provider-mark" data-logo={provider !== "custom_mcp" ? "" : undefined} aria-hidden="true">{icon}</span>
    : icon;
}
