import { ShieldAlertIcon } from "lucide-react";
import { t } from "../i18n";
import "../styles/connection.css";

/** Shown above everything, the login page included, while the page is not a secure context (A51): plain HTTP from
 * another machine, which the owner allowed in Settings. A reverse proxy that adds TLS gives a secure context. */
export function InsecureBanner() {
  const https = `https://${location.host}${location.pathname}${location.search}`;
  return <div className="jv-insecure" role="status"><ShieldAlertIcon aria-hidden="true"/><span>{t("connection.insecure")}</span><a href={https}>{t("connection.useHttps")}</a></div>;
}
