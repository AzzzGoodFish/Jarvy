import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/shadcn.css";
import "./styles/shell.css";
import "./styles/rich-text.css";
import "./styles/login.css";
import "./styles/attachments.css";
import "./styles/jarvy.css";
import "./styles/channels.css";
import "./styles/threads.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
