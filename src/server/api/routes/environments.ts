import { Readable } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { messageView } from "../views/chat.js";
import type { HostKeys } from "../../../contract/environment.js";

/** The Environments page: the owner's SSH machines (A57, A59) and the computers the desktop client connected (A96). A password goes in once, to install Jarvy's key,
 * and is kept (sealed) only for a machine that refuses keys; private keys and passwords never come back out. */
export function environmentRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>(), machines = bots.machines;
  routes.get("/", c => c.json({ machines: machines.list() }));
  /** Whether VM sandboxes can be used on this machine (A85): a trial VM the first time, and again when asked. */
  routes.get("/vm", c => c.json(bots.vmSupport()));
  routes.post("/vm/check", c => c.json(bots.vmSupport(true)));
  /** The host keys a machine presents, for the owner to check before typing its password. */
  routes.post("/scan", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.scan({ host: input.host, port: input.port, user: input.user }));
  });
  /** A key for the owner to add to a machine themselves, instead of giving its password (A59). */
  routes.post("/keys", async c => c.json(await machines.prepareKey(), 201));
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.add({ name: input.name, host: input.host, port: input.port, user: input.user, directory: input.directory, description: input.description,
      password: input.password, ...(input.keyId !== undefined ? { keyId: input.keyId } : {}), hostKeys: hostKeys(input.hostKeys) }), 201);
  });
  /** A new password for a machine reached with its password, checked with a login first. */
  routes.put("/:id/password", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.setPassword(c.req.param("id"), input.password));
  });
  routes.put("/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(machines.update(c.req.param("id"), { name: input.name, directory: input.directory, description: input.description }));
  });
  /** Scans again, to see whether the machine still presents the accepted keys. */
  routes.post("/:id/check", async c => c.json(await machines.check(c.req.param("id"))));
  /** Accepts the keys the machine presents now, given the fingerprints the owner saw. */
  routes.post("/:id/trust", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.trust(c.req.param("id"), input.fingerprints));
  });
  /** Removes Jarvy's key from the machine first; `force=1` deletes it even when that fails. */
  routes.delete("/:id", async c => { await bots.removeMachine(c.req.param("id"), c.req.query("force") === "1"); return c.json({ ok: true }); });
  routes.put("/:id/grants/:botId", jsonBody, async c => {
    const input = await readJson(c);
    if (typeof input.granted !== "boolean") throw new HTTPException(400, { message: "granted must be true or false" });
    bots.grantMachine(c.req.param("botId"), c.req.param("id"), input.granted);
    return c.json(machines.get(c.req.param("id")));
  });
  /** Computers the desktop client connected (A96). The client registers the one it runs on while signed in as the
   * owner, and gets its token once. */
  const devices = bots.devices;
  routes.get("/devices", c => c.json({ devices: devices.list() }));
  routes.post("/devices", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(devices.register({ name: input.name }), 201);
  });
  routes.put("/devices/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(devices.update(c.req.param("id"), { name: input.name, description: input.description, directory: input.directory, shell: input.shell }));
  });
  /** Unpairs it: its token stops working, and Bots working there go back to their sandboxes, told. */
  routes.delete("/devices/:id", c => { bots.removeDevice(c.req.param("id")); return c.json({ ok: true }); });
  routes.put("/devices/:id/grants/:botId", jsonBody, async c => {
    const input = await readJson(c);
    if (typeof input.granted !== "boolean") throw new HTTPException(400, { message: "granted must be true or false" });
    bots.grantDevice(c.req.param("botId"), c.req.param("id"), input.granted);
    return c.json(devices.get(c.req.param("id")));
  });
  /** The owner's answer on a Bot's request card: the password, used to install the key, or a prepared key. */
  routes.post("/requests/:chatId/:messageId", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(messageView(await machines.fulfil(c.get("actorId"), c.req.param("chatId"), c.req.param("messageId"),
      { password: input.password, ...(input.keyId !== undefined ? { keyId: input.keyId } : {}) })));
  });
  return routes;
}

function hostKeys(value: unknown): HostKeys {
  const keys = value as { keys?: unknown; fingerprints?: unknown } | null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.length > 0 && list.length <= 20 && list.every(item => typeof item === "string" && item.length <= 2000);
  if (!keys || !strings(keys.keys) || !strings(keys.fingerprints)) throw new HTTPException(400, { message: "hostKeys must be what the scan returned" });
  return { keys: keys.keys, fingerprints: keys.fingerprints };
}

/** The pi-env daemon for a computer's system, which its client runs (A96): asked for with the computer's own token,
 * before any sign-in, so it sits outside the session check. */
export function deviceDaemonRoute(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/devices/daemon", c => {
    const token = /^Device\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const { open, sha256, size } = bots.devices.daemon(token, c.req.query("platform") ?? "", c.req.query("arch") ?? "");
    // A client that has this one already (it reconnects often) gets no body.
    if (c.req.header("if-none-match") === `"${sha256}"`) return new Response(null, { status: 304, headers: { "X-Daemon-Sha256": sha256, ETag: `"${sha256}"` } });
    return new Response(Readable.toWeb(Readable.from(open())) as ReadableStream, { headers: { "Content-Type": "application/octet-stream",
      "Content-Length": String(size), "X-Daemon-Sha256": sha256, ETag: `"${sha256}"`, "Cache-Control": "no-store" } });
  });
  /** The command-line client, for a computer to connect itself with `node connector.mjs <address>`. */
  routes.get("/devices/connector.mjs", c => {
    const script = bots.devices.connector();
    if (!script) throw new HTTPException(404, { message: "The connector is built with npm run build" });
    return c.body(new Uint8Array(script), 200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Disposition": 'attachment; filename="connector.mjs"', "Cache-Control": "no-store" });
  });
  return routes;
}
