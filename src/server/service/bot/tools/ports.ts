import { Type } from "typebox";
import type { PublishedPort } from "../../../../contract/ports.js";
import { None, tool } from "./registry.js";
import type { ToolContext } from "./context.js";

const Port = Type.Integer({ minimum: 1, maximum: 65535, description: "The port your service listens on in your sandbox" });
const LOOPBACK = "Something listens on this port only on 127.0.0.1 (or ::1) in your sandbox, which the link can't reach: restart it listening on 0.0.0.0, such as vite --host 0.0.0.0, next dev -H 0.0.0.0 or python3 -m http.server --bind 0.0.0.0.";
const NOTE: Record<PublishedPort["state"], string> = {
  live: "Your service is reachable through the link.",
  local: LOOPBACK,
  idle: "Nothing listens on this port in your sandbox yet; the link works once your service listens there on 0.0.0.0.",
  stopped: "Your sandbox isn't running; the link works once it runs and your service listens there.",
  unknown: "Whether your service listens there couldn't be checked.",
};

/** How a Bot reads one of its published ports. */
function row(context: ToolContext, port: PublishedPort) {
  const { fromSandboxes } = context.scope.ports.links(port.hostPort);
  return { port: port.port, name: port.name, description: port.description, url: port.urls[0] ?? null,
    ...(port.urls.length > 1 ? { otherUrls: port.urls.slice(1) } : {}), ...(fromSandboxes ? { fromSandboxes } : {}), state: port.state, note: NOTE[port.state] };
}

/** The ports tools (A74): a Bot shows a web service in its sandbox to people and other Bots by publishing its port. */
export const portTools = [
  tool("ports.publish", "Publish a web service that runs in your sandbox, so people can open it in their browser and other Bots of this chat platform can reach it. You get a link (url) on this chat platform's own port for it: send it in the chat for people; other Bots use fromSandboxes. Only people signed in to this chat platform and its Bots can open it. The service has to listen on 0.0.0.0, not only on 127.0.0.1. Publishing a port again changes its name and description and keeps its link. It stays published until you unpublish it or your sandbox is reset; your owner sees it in your Bot info and can unpublish it there.",
    Type.Object({ port: Port,
      name: Type.String({ minLength: 1, maxLength: 60, description: "A short name, in your owner's language, such as the app's name" }),
      description: Type.String({ minLength: 1, maxLength: 300, description: "What it is and what to look at there, in your owner's language" }) }, { additionalProperties: false }),
    async (input, context) => row(context, await context.scope.ports.publish(context.bot, input))),
  tool("ports.list", "List the ports you published: each one's port, name, description, link, the link other Bots use (fromSandboxes), and state: live (reachable), local (listening on 127.0.0.1 only, which the link can't reach), idle (nothing listens), stopped (your sandbox isn't running).",
    None, async (_args, context) => ({ ports: (await context.scope.ports.list(context.bot)).map(port => row(context, port)) })),
  tool("ports.unpublish", "Unpublish one of your ports: its link stops working. Your service keeps running in your sandbox.",
    Type.Object({ port: Port }, { additionalProperties: false }), ({ port }, context) => { context.scope.ports.unpublish(context.bot, port); return { port, unpublished: true }; }),
];
