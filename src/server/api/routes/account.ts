import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AccountService } from "../../service/account/service.js";
import type { ApiEnv } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { clientIp, IpRateLimiter } from "../middleware/rate-limit.js";

const encrypted = (c: Context<ApiEnv>) => !!(c.env.incoming.socket as { encrypted?: boolean }).encrypted;
function sessionCookie(c: Context<ApiEnv>, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, { httpOnly: true, sameSite: "Strict", path: "/", maxAge, secure: encrypted(c) });
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The session cookie's name. Browsers scope cookies by host, not port: instances on one host need distinct names or
 * logging into one overwrites the other's session. HTTPS has a name of its own (A51): a plain-HTTP page may not
 * overwrite a Secure cookie of the same name, so signing in over HTTP after HTTPS would silently keep failing. */
export const sessionCookieName = (instance: string, secure: boolean) => secure ? `jarvy_session_${instance}_tls` : `jarvy_session_${instance}`;

export function installAuthentication(api: Hono<ApiEnv>, account: AccountService) {
  const cookie = (c: Context<ApiEnv>) => sessionCookieName(account.instance, encrypted(c));
  const unauthProbeLimiter = new IpRateLimiter({ maxPerWindow: 60, windowMs: 60_000, burst: 25 });
  const loginLimiter = new IpRateLimiter({ maxPerWindow: 20, windowMs: 60_000, burst: 10 });

  api.post("/login", jsonBody, async c => {
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    const retrySec = loginLimiter.take(ip);
    if (retrySec > 0) {
      c.header("Retry-After", String(retrySec));
      account.audit("rate_limited", ip, "POST /api/login");
      throw new HTTPException(429, { message: "Too many login attempts; try again later" });
    }
    const input = await readJson(c);
    const result = account.login(input.username, input.password, ip, input.totp);
    if (result.type === "limited") {
      c.header("Retry-After", String(result.retryAfterSec));
      throw new HTTPException(429, { message: "Too many login attempts; try again later" });
    }
    if (result.type === "totp_required") {
      return c.json({ error: "Two-factor authentication code required", code: "totp_required" }, 401);
    }
    if (result.type === "totp_invalid") {
      if (result.delayMs > 0) await delay(result.delayMs);
      return c.json({ error: "Invalid verification code", code: "totp_invalid" }, 401);
    }
    if (result.type === "invalid") {
      if (result.delayMs > 0) await delay(result.delayMs);
      throw new HTTPException(401, { message: "Invalid username or password" });
    }
    sessionCookie(c, cookie(c), result.token, 7 * 24 * 60 * 60);
    return c.json({ username: result.username });
  });

  api.use("*", async (c, next) => {
    const token = getCookie(c, cookie(c));
    if (!account.authenticated(token)) {
      const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
      const retrySec = unauthProbeLimiter.take(ip);
      if (retrySec > 0) {
        c.header("Retry-After", String(retrySec));
        account.audit("rate_limited", ip, `unauth ${c.req.method} ${c.req.path}`);
        throw new HTTPException(429, { message: "Too many requests; try again later" });
      }
      throw new HTTPException(401, { message: "Login required" });
    }
    c.set("sessionToken", token!);
    c.set("actorId", account.identity().id);
    await next();
  });

  api.get("/me", c => c.json({ username: account.identity().username }));
  api.post("/logout", c => {
    account.logout(c.get("sessionToken"));
    sessionCookie(c, cookie(c), "", 0);
    // Attachments stay in this browser's cache while signed in (they are fetched once, kept per session cookie); signing
    // out also empties it where the browser honours this (HTTPS or this machine).
    c.header("Clear-Site-Data", '"cache"');
    return c.json({ ok: true });
  });

  // Security & 2FA management routes (A112)
  api.get("/security", c => c.json(account.securityStatus()));
  api.post("/security/totp/setup", c => c.json(account.beginTotpSetup()));
  api.post("/security/totp/enable", jsonBody, async c => {
    const input = await readJson(c);
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    return c.json(account.enableTotp(input.password, input.code, ip));
  });
  api.post("/security/totp/disable", jsonBody, async c => {
    const input = await readJson(c);
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    account.disableTotp(input.password, input.code, ip);
    return c.json({ ok: true });
  });
  api.post("/security/totp/recovery-codes", jsonBody, async c => {
    const input = await readJson(c);
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    return c.json(account.regenerateRecoveryCodes(input.password, input.code, ip));
  });
  api.post("/security/sessions/revoke-others", c => {
    const ip = clientIp(c, account.runtimeSecurityFlags().trustProxy);
    return c.json(account.revokeOtherSessions(c.get("sessionToken"), ip));
  });
}
