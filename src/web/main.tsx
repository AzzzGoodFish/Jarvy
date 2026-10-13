import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useLocale } from "./i18n";
import "./styles/tokens.css";
import "./styles/shadcn.css";
import "./styles/shell.css";
import "./styles/rich-text.css";
import "./styles/login.css";
import "./styles/attachments.css";
import "./styles/jarvy.css";
import "./styles/channels.css";
import "./styles/threads.css";

/** Subscribes to the interface language (A45), so switching it re-renders the whole app in place — open dialogs and panes stay. */
function Root() {
  useLocale();
  return <App/>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Root/></StrictMode>);
