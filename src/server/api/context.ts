import type { HttpBindings } from "@hono/node-server";
import type { Application } from "../application.js";

/** sandboxedDocument: the response is an untrusted HTML attachment run in a sandbox (A35); the
 * security middleware gives it the sandbox policy instead of the app's. */
export type ApiEnv = { Bindings: HttpBindings; Variables: { actorId: string; sessionToken: string; sandboxedDocument?: boolean } };
/** API modules receive only business services, never Store, filesystem or Pi objects. */
export type ApiServices = Pick<Application, "account" | "bots" | "chats" | "models" | "events" | "connection">;
