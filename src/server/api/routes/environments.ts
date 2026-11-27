import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { clientIp, IpRateLimiter } from "../middleware/rate-limit.js";
import { sessionCookieName } from "./account.js";
import { messageView } from "../views/chat.js";
import type { HostKeys } from "../../../contract/environment.js";
import { renderInstallPs1, renderInstallSh } from "../../service/bot/device-pairing.js";

/** The Environments page: the owner's SSH machines (A57, A59) and the computers the desktop client connected (A96). A password goes in once, to install Jarvy's key,
 * and is kept (sealed) only for a machine that refuses keys; private keys and passwords never come back out. */
export function environmentRoutes(bots: ApiServices["bots"], connection?: ApiServices["connection"]) {
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
  /** Issues a short-lived single-use enrollment token for zero-password `jarvy-agent join` (A111). */
  routes.post("/devices/pairing-token", jsonBody, async c => {
    const input = await readJson(c);
    const issued = devices.issuePairingToken({ name: input.name, ttlSeconds: input.ttlSeconds });
    return c.json({ ...issued, fingerprint: connection?.info().fingerprint ?? null }, 201);
  });
  routes.delete("/devices/pairing-token/:id", c => {
    devices.revokePairingToken(c.req.param("id"));
    return c.json({ ok: true });
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

/** Checks whether a request is authorized to download device installers/binaries: owner session cookie, registered
 * `Authorization: Device <token>`, or an active one-time pairing token (`?token=` / `X-Pairing-Token`) (A112). */
function assertDeviceDownloadAccess(c: Context<ApiEnv>, bots: ApiServices["bots"], account: ApiServices["account"], ip: string): void {
  const isTls = !!(c.env.incoming.socket as { encrypted?: boolean }).encrypted;
  const sessionToken = getCookie(c, sessionCookieName(account.instance, isTls));
  if (account.authenticated(sessionToken)) return;
  const deviceToken = /^Device\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (bots.devices.hasDeviceToken(deviceToken)) return;
  const pairingToken = c.req.query("token") ?? c.req.header("x-pairing-token");
  if (pairingToken && bots.devices.hasValidPairingToken(pairingToken, ip)) return;
  account.audit("download_denied", ip, `GET ${c.req.path}`);
  throw new HTTPException(403, { message: "Valid session, device token, or active pairing token required" });
}

/** The pi-env daemon for a computer's system, which its client runs (A96): asked for with the computer's own token,
 * before any sign-in, so it sits outside the session check. */
export function deviceDaemonRoute(bots: ApiServices["bots"], account: ApiServices["account"]) {
  const routes = new Hono<ApiEnv>();
  const downloadLimiter = new IpRateLimiter({ maxPerWindow: 20, windowMs: 60_000, burst: 10 });
  const enrollLimiter = new IpRateLimiter({ maxPerWindow: 15, windowMs: 60_000, burst: 8 });
  const checkLimit = (c: Context<ApiEnv>, limiter: IpRateLimiter) => {
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    const retry = limiter.take(ip);
    if (retry > 0) {
      c.header("Retry-After", String(retry));
      account.audit("rate_limited", ip, `${c.req.method} ${c.req.path}`);
      throw new HTTPException(429, { message: "Too many requests; try again later" });
    }
    return ip;
  };

  routes.get("/devices/daemon", c => {
    checkLimit(c, downloadLimiter);
    const token = /^Device\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const { open, sha256, size } = bots.devices.daemon(token, c.req.query("platform") ?? "", c.req.query("arch") ?? "");
    // A client that has this one already (it reconnects often) gets no body.
    if (c.req.header("if-none-match") === `"${sha256}"`) return new Response(null, { status: 304, headers: { "X-Daemon-Sha256": sha256, ETag: `"${sha256}"` } });
    return new Response(Readable.toWeb(Readable.from(open())) as ReadableStream, { headers: { "Content-Type": "application/octet-stream",
      "Content-Length": String(size), "X-Daemon-Sha256": sha256, ETag: `"${sha256}"`, "Cache-Control": "no-store" } });
  });
  /** The command-line client, for a computer to connect itself with `node connector.mjs <address>` (gated in A112). */
  routes.get("/devices/connector.mjs", c => {
    const ip = checkLimit(c, downloadLimiter);
    assertDeviceDownloadAccess(c, bots, account, ip);
    const script = bots.devices.connector();
    if (!script) throw new HTTPException(404, { message: "The connector is built with npm run build" });
    return c.body(new Uint8Array(script), 200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Disposition": 'attachment; filename="connector.mjs"', "Cache-Control": "no-store" });
  });
  /** Redeems a short-lived single-use pairing token to enroll a remote computer without owner password (A111). */
  routes.post("/devices/enroll", jsonBody, async c => {
    const ip = checkLimit(c, enrollLimiter);
    const input = await readJson(c);
    try {
      const enrolled = bots.devices.enroll({ token: input.token, name: input.name }, ip);
      account.audit("device_enrolled", ip, `name=${enrolled.device.name}`);
      return c.json(enrolled, 201);
    } catch (error) {
      account.audit("enroll_failed", ip, error instanceof Error ? error.message : "invalid token");
      throw error;
    }
  });
  /** Native zero-Node `jarvy-agent` binary download with SHA-256 + ETag for idle self-updates (A111, A112, A113). */
  routes.get("/devices/agent", c => {
    const ip = checkLimit(c, downloadLimiter);
    assertDeviceDownloadAccess(c, bots, account, ip);
    const { open, filename, size, sha256, version } = bots.devices.agentBinary(c.req.query("platform") ?? "", c.req.query("arch") ?? "");
    const metaHeaders = {
      "X-Agent-Sha256": sha256,
      "X-Agent-Version": version,
      ETag: `"${sha256}"`,
      "Cache-Control": "no-store",
    };
    if (c.req.header("if-none-match") === `"${sha256}"`) {
      return new Response(null, { status: 304, headers: metaHeaders });
    }
    return new Response(Readable.toWeb(Readable.from(open())) as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...metaHeaders,
      },
    });
  });
  /** One-line installer scripts for Linux/macOS (`install.sh`) and Windows (`install.ps1`) (A111, gated in A112). */
  routes.get("/devices/install.sh", c => {
    const ip = checkLimit(c, downloadLimiter);
    assertDeviceDownloadAccess(c, bots, account, ip);
    return c.body(renderInstallSh(), 200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
  });
  routes.get("/devices/install.ps1", c => {
    const ip = checkLimit(c, downloadLimiter);
    assertDeviceDownloadAccess(c, bots, account, ip);
    return c.body(renderInstallPs1(), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  });
  return routes;
}
