import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { messageView } from "../views/chat.js";
import type { HostKeys } from "../../../contract/environment.js";

/** Settings → work environments: the owner's SSH machines (A57, A59). A password goes in once, to install Jarvy's key,
 * and is kept (sealed) only for a machine that refuses keys; private keys and passwords never come back out. */
export function environmentRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>(), machines = bots.machines;
  routes.get("/", c => c.json({ machines: machines.list() }));
  /** The host keys a machine presents, for the owner to check before typing its password. */
  routes.post("/scan", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.scan({ host: input.host, port: input.port, user: input.user }));
  });
  /** A key for the owner to add to a machine themselves, instead of giving its password (A59). */
  routes.post("/keys", async c => c.json(await machines.prepareKey(), 201));
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.add({ name: input.name, host: input.host, port: input.port, user: input.user, directory: input.directory,
      password: input.password, ...(input.keyId !== undefined ? { keyId: input.keyId } : {}), hostKeys: hostKeys(input.hostKeys) }), 201);
  });
  /** A new password for a machine reached with its password, checked with a login first. */
  routes.put("/:id/password", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await machines.setPassword(c.req.param("id"), input.password));
  });
  routes.put("/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(machines.update(c.req.param("id"), { name: input.name, directory: input.directory }));
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
