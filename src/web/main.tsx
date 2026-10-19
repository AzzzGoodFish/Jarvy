import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useLocale } from "./i18n";
import { InsecureBanner } from "./connection/InsecureBanner";
import "./styles/tokens.css";
import "./styles/shadcn.css";
import "./styles/shell.css";
import "./styles/rich-text.css";
import "./styles/login.css";
import "./styles/attachments.css";
import "./styles/jarvy.css";
import "./styles/channels.css";
import "./styles/threads.css";

/** Subscribes to the interface language (A45), so switching it re-renders the whole app in place — open dialogs and panes stay.
 * A page that is not a secure context (plain HTTP from another machine, A51) keeps a warning above everything. */
function Root() {
  useLocale();
  return window.isSecureContext ? <App/> : <div className="jv-insecure-shell"><InsecureBanner/><App/></div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Root/></StrictMode>);
