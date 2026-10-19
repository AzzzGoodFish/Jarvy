import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AccountService } from "../../service/account/service.js";
import type { ApiEnv } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";

const encrypted = (c: Context<ApiEnv>) => !!(c.env.incoming.socket as { encrypted?: boolean }).encrypted;
function sessionCookie(c: Context<ApiEnv>, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, { httpOnly: true, sameSite: "Strict", path: "/", maxAge, secure: encrypted(c) });
}
export function installAuthentication(api: Hono<ApiEnv>, account: AccountService) {
  // Browsers scope cookies by host, not port: instances on one host need distinct names or
  // logging into one overwrites the other's session.
  // HTTPS has a name of its own (A51): a plain-HTTP page may not overwrite a Secure cookie of the same name, so signing
  // in over HTTP after HTTPS would silently keep failing.
  const BASE = `jarvy_session_${account.instance}`, cookie = (c: Context<ApiEnv>) => encrypted(c) ? `${BASE}_tls` : BASE;
  api.post("/login", jsonBody, async c => {
    const input = await readJson(c);
    const result = account.login(input.username, input.password, c.env.incoming.socket.remoteAddress ?? "unknown");
    if (result.type === "limited") throw new HTTPException(429, { message: "Too many login attempts; try again later" });
    if (result.type === "invalid") throw new HTTPException(401, { message: "Invalid username or password" });
    sessionCookie(c, cookie(c), result.token, 7 * 24 * 60 * 60);
    return c.json({ username: result.username });
  });
  api.use("*", async (c, next) => {
    const token = getCookie(c, cookie(c));
    if (!account.authenticated(token)) throw new HTTPException(401, { message: "Login required" });
    c.set("sessionToken", token!); c.set("actorId", account.identity().id);
    await next();
  });
  api.get("/me", c => c.json({ username: account.identity().username }));
  api.post("/logout", c => {
    account.logout(c.get("sessionToken")); sessionCookie(c, cookie(c), "", 0);
    return c.json({ ok: true });
  });
}
