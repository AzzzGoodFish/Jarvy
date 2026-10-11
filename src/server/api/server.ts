import { createServer, type Server } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { ApiServices } from "./context.js";
import { createHttpApp } from "./app.js";

export function createJarvyServer(services: ApiServices, webRoot: string): Server {
  const app = createHttpApp(services, webRoot);
  // HTTP/1 bindings are supplied by node:http. Keep Pi's global Fetch objects untouched.
  return createServer(getRequestListener((request, bindings) => app.fetch(request, bindings as HttpBindings), { overrideGlobalObjects: false }));
}
