import type { Context } from "hono";
import type { ApiEnv, ApiServices } from "./context.js";
import type { MessageOrigin } from "../service/chat/envelope.js";
import { fromThisMachine } from "./server.js";

function platformLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^"|"$/g, "").toLowerCase();
  if (!value) return null;
  if (value === "win32" || value.includes("windows")) return "Windows";
  if (value === "darwin" || value.includes("macos") || value.includes("mac os") || value.includes("macintosh")) return "macOS";
  if (value === "ios" || value.includes("iphone") || value.includes("ipad") || value.includes("ipod")) return "iOS";
  if (value.includes("android")) return "Android";
  if (value.includes("cros") || value.includes("chrome os") || value.includes("chromeos")) return "ChromeOS";
  if (value === "linux" || value.includes("linux")) return "Linux";
  return null;
}

function osFromUserAgent(ua: string): { mobile: boolean; os: string | null } {
  const lower = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(lower)) return { mobile: true, os: "iOS" };
  if (lower.includes("android")) return { mobile: true, os: "Android" };
  if (lower.includes("windows")) return { mobile: false, os: "Windows" };
  if (lower.includes("macintosh") || lower.includes("mac os x")) return { mobile: false, os: "macOS" };
  if (lower.includes("cros")) return { mobile: false, os: "ChromeOS" };
  if (lower.includes("linux")) return { mobile: false, os: "Linux" };
  if (lower.includes("mobile")) return { mobile: true, os: null };
  return { mobile: false, os: null };
}

/** Identifies which client / device / OS the user sent a message from (A106).
 * Paired desktop clients resolve to their canonical registered device (via + env id);
 * browsers and unpaired desktop clients report form factor, OS, and whether the request came from this host (local). */
export function resolveMessageOrigin(
  input: {
    deviceId?: string | null;
    client?: string | null;
    platform?: string | null;
    secPlatform?: string | null;
    secMobile?: string | null;
    userAgent?: string | null;
    remoteAddress?: string | null;
  },
  lookupDevice: (id: string) => { id: string; name: string; platform?: string } | undefined,
): MessageOrigin | undefined {
  const ua = (input.userAgent ?? "").trim();
  const uaInfo = ua ? osFromUserAgent(ua) : { mobile: false, os: null };
  const os = platformLabel(input.platform ?? undefined) ?? platformLabel(input.secPlatform ?? undefined) ?? uaInfo.os;
  const deviceId = input.deviceId?.trim();
  if (deviceId) {
    const device = lookupDevice(deviceId);
    if (device) {
      const deviceOs = platformLabel(device.platform) ?? os;
      return { via: deviceOs ? `${device.name} (${deviceOs})` : device.name, env: device.id };
    }
  }
  const local = !!input.remoteAddress && fromThisMachine(input.remoteAddress);
  const isDesktop = input.client?.trim().toLowerCase() === "desktop" || /\bElectron\//i.test(ua);
  if (isDesktop) {
    const parts = [os, local ? "local" : null].filter((value): value is string => !!value);
    return { via: parts.length ? `Desktop (${parts.join(", ")})` : "Desktop" };
  }
  const isMobile = input.secMobile?.trim() === "?1" || uaInfo.mobile;
  if (isMobile) {
    return { via: os ? `Mobile (${os})` : "Mobile" };
  }
  if (os || local) {
    const parts = [os, local ? "local" : null].filter((value): value is string => !!value);
    return { via: `Web (${parts.join(", ")})` };
  }
  return undefined;
}

export function messageOrigin(c: Context<ApiEnv>, bots: ApiServices["bots"]): MessageOrigin | undefined {
  return resolveMessageOrigin(
    {
      deviceId: c.req.header("x-jarvy-device"),
      client: c.req.header("x-jarvy-client"),
      platform: c.req.header("x-jarvy-platform"),
      secPlatform: c.req.header("sec-ch-ua-platform"),
      secMobile: c.req.header("sec-ch-ua-mobile"),
      userAgent: c.req.header("user-agent"),
      remoteAddress: c.env.incoming?.socket?.remoteAddress,
    },
    id => bots.devices.list().find(device => device.id === id),
  );
}
