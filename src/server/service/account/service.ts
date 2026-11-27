import type { SecurityStatus, TotpEnableResponse, TotpSetupResponse } from "../../../contract/security.js";
import type { Store } from "../../infra/storage/store.js";
import { ValidationError } from "../../shared/errors.js";
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  renderQrSvg,
  verifyTotp,
} from "./totp.js";

const TOTP_SECRET_KEY = "account_totp_secret";
const TOTP_RECOVERY_KEY = "account_totp_recovery";
const TOTP_LAST_STEP_KEY = "account_totp_last_step";
const TOTP_AAD = "account:totp";

const IP_SOFT_LIMIT = 6;
const IP_HARD_LIMIT = 12;
const GLOBAL_SOFT_LIMIT = 20;
const GLOBAL_HARD_LIMIT = 40;
const SOFT_LOCK_MS = 15 * 60_000;
const HARD_LOCK_MS = 60 * 60_000;
const WINDOW_RESET_MS = 15 * 60_000;
const PENDING_SETUP_TTL_MS = 10 * 60_000;

export interface RuntimeSecurityFlags {
  tlsOnly: boolean;
  noWeb: boolean;
  localWebPort: number | null;
  trustProxy: boolean;
}

export type LoginResult =
  | { type: "success"; token: string; username: string }
  | { type: "invalid"; delayMs: number }
  | { type: "totp_required" }
  | { type: "totp_invalid"; delayMs: number }
  | { type: "limited"; retryAfterSec: number };

/** Account authentication, dual-layer anti-brute-force throttling, TOTP 2FA, and security audit logging (A112). */
export class AccountService {
  private pendingTotp: { secret: string; expiresAt: number } | null = null;
  private runtimeFlags: RuntimeSecurityFlags = { tlsOnly: false, noWeb: false, localWebPort: null, trustProxy: false };

  /** `instance` tells apart Jarvy data directories served from the same host (see the session cookie). */
  constructor(private readonly store: Store, readonly instance: string) {}

  setRuntimeSecurityFlags(flags: Partial<RuntimeSecurityFlags>): void {
    this.runtimeFlags = { ...this.runtimeFlags, ...flags };
  }

  runtimeSecurityFlags(): RuntimeSecurityFlags {
    return { ...this.runtimeFlags };
  }

  /** Structured security event logger: persists to SQLite and prints a fail2ban-friendly `[security]` log line. */
  audit(kind: string, ip: string, detail = ""): void {
    const cleanIp = ip || "unknown";
    const safeDetail = detail.replace(/[\r\n]+/g, " ").trim();
    console.warn(`[security] kind=${kind} ip=${cleanIp}${safeDetail ? ` detail=${safeDetail}` : ""}`);
    try {
      this.store.security.recordEvent(kind, cleanIp, safeDetail);
    } catch {
      /* Avoid breaking request handling if DB is closing. */
    }
  }

  login(username: unknown, password: unknown, clientIp: string, totpCode?: unknown): LoginResult {
    const ip = clientIp || "unknown";
    const now = Date.now();
    const retryAfterSec = this.checkLocked(ip, now);
    if (retryAfterSec > 0) {
      this.audit("login_blocked", ip, `retry_after=${retryAfterSec}s`);
      return { type: "limited", retryAfterSec };
    }

    if (!this.store.account.verifyCredentials(username, password)) {
      const delayMs = this.recordFailure(ip, now);
      this.audit("login_failed", ip, "invalid credentials");
      return { type: "invalid", delayMs };
    }

    if (this.totpEnabled()) {
      const code = typeof totpCode === "string" ? totpCode.trim() : "";
      if (!code) return { type: "totp_required" };
      if (!this.verifySecondFactor(code, now)) {
        const delayMs = this.recordFailure(ip, now);
        this.audit("totp_failed", ip, "invalid 2FA or recovery code");
        return { type: "totp_invalid", delayMs };
      }
    }

    this.clearThrottle(ip);
    const token = this.store.account.createSession();
    this.audit("login_success", ip, this.totpEnabled() ? "password+totp" : "password");
    return { type: "success", token, username: this.store.account.username()! };
  }

  authenticated(token: string | undefined) { return this.store.account.authenticated(token); }
  identity() { return { id: this.store.account.userMemberId(), username: this.store.account.username() }; }
  logout(token: string) { this.store.account.logout(token); }

  totpEnabled(): boolean {
    return this.openTotpSecret() !== null;
  }

  securityStatus(): SecurityStatus {
    return {
      totpEnabled: this.totpEnabled(),
      recoveryCodesRemaining: this.recoveryHashes().length,
      activeSessions: this.store.account.activeSessionCount(),
      tlsOnly: this.runtimeFlags.tlsOnly,
      noWeb: this.runtimeFlags.noWeb,
      localWebPort: this.runtimeFlags.localWebPort,
      trustProxy: this.runtimeFlags.trustProxy,
      recentEvents: this.store.security.recentEvents(30),
    };
  }

  beginTotpSetup(): TotpSetupResponse {
    const account = this.store.account.username() ?? "owner";
    const issuer = "Jarvy";
    const secret = generateTotpSecret();
    this.pendingTotp = { secret, expiresAt: Date.now() + PENDING_SETUP_TTL_MS };
    const otpauthUrl = buildOtpAuthUri(issuer, account, secret);
    return { secret, otpauthUrl, qrSvg: renderQrSvg(otpauthUrl), issuer, account };
  }

  enableTotp(password: unknown, code: unknown, ip: string): TotpEnableResponse {
    if (!this.store.account.verifyPassword(password)) {
      this.audit("totp_setup_failed", ip, "wrong password");
      throw new ValidationError("Current password is incorrect");
    }
    const pending = this.pendingTotp;
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingTotp = null;
      throw new ValidationError("2FA setup expired; start setup again");
    }
    const codeStr = typeof code === "string" ? code.trim() : "";
    const step = verifyTotp(pending.secret, codeStr);
    if (step === null) {
      this.audit("totp_setup_failed", ip, "invalid verification code");
      throw new ValidationError("Invalid 6-digit verification code");
    }
    const recoveryCodes = generateRecoveryCodes(8);
    const hashes = recoveryCodes.map(hashRecoveryCode);
    this.store.settings.set(TOTP_SECRET_KEY, this.store.cipher.seal(pending.secret, TOTP_AAD));
    this.store.settings.set(TOTP_RECOVERY_KEY, JSON.stringify(hashes));
    this.store.settings.set(TOTP_LAST_STEP_KEY, String(step));
    this.pendingTotp = null;
    this.audit("totp_enabled", ip, "2FA enabled with 8 recovery codes");
    return { enabled: true, recoveryCodes };
  }

  disableTotp(password: unknown, code: unknown, ip: string): void {
    if (!this.totpEnabled()) return;
    if (!this.store.account.verifyPassword(password)) {
      this.audit("totp_disable_failed", ip, "wrong password");
      throw new ValidationError("Current password is incorrect");
    }
    const codeStr = typeof code === "string" ? code.trim() : "";
    if (!this.verifySecondFactor(codeStr, Date.now())) {
      this.audit("totp_disable_failed", ip, "invalid 2FA code");
      throw new ValidationError("Invalid 2FA or recovery code");
    }
    this.clearTotp();
    this.audit("totp_disabled", ip, "2FA disabled");
  }

  regenerateRecoveryCodes(password: unknown, code: unknown, ip: string): { recoveryCodes: string[] } {
    if (!this.totpEnabled()) throw new ValidationError("2FA is not enabled");
    if (!this.store.account.verifyPassword(password)) throw new ValidationError("Current password is incorrect");
    const codeStr = typeof code === "string" ? code.trim() : "";
    if (!this.verifySecondFactor(codeStr, Date.now())) throw new ValidationError("Invalid 2FA or recovery code");
    const recoveryCodes = generateRecoveryCodes(8);
    this.store.settings.set(TOTP_RECOVERY_KEY, JSON.stringify(recoveryCodes.map(hashRecoveryCode)));
    this.audit("totp_recovery_rotated", ip, "regenerated 8 recovery codes");
    return { recoveryCodes };
  }

  /** CLI escape hatch (`jarvy server reset-2fa`) when the owner loses their authenticator device. */
  resetTotpFromCli(): boolean {
    const wasEnabled = this.totpEnabled();
    this.clearTotp();
    if (wasEnabled) this.audit("totp_reset_cli", "localhost", "2FA disabled via CLI");
    return wasEnabled;
  }

  revokeOtherSessions(keepToken: string, ip: string): { revoked: number } {
    const revoked = this.store.account.revokeOtherSessions(keepToken);
    this.audit("sessions_revoked", ip, `revoked=${revoked}`);
    return { revoked };
  }

  private clearTotp(): void {
    this.pendingTotp = null;
    this.store.settings.set(TOTP_SECRET_KEY, null);
    this.store.settings.set(TOTP_RECOVERY_KEY, null);
    this.store.settings.set(TOTP_LAST_STEP_KEY, null);
  }

  private openTotpSecret(): string | null {
    const sealed = this.store.settings.get(TOTP_SECRET_KEY);
    if (!sealed) return null;
    return this.store.cipher.open(sealed, TOTP_AAD);
  }

  private recoveryHashes(): string[] {
    const raw = this.store.settings.get(TOTP_RECOVERY_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private verifySecondFactor(code: string, nowMs: number): boolean {
    const secret = this.openTotpSecret();
    if (!secret) return false;
    const lastStep = Number(this.store.settings.get(TOTP_LAST_STEP_KEY) ?? "-1");
    const step = verifyTotp(secret, code, nowMs, Number.isFinite(lastStep) ? lastStep : -1);
    if (step !== null) {
      this.store.settings.set(TOTP_LAST_STEP_KEY, String(step));
      return true;
    }
    // Check single-use recovery codes.
    const candidateHash = hashRecoveryCode(code);
    const hashes = this.recoveryHashes();
    const idx = hashes.indexOf(candidateHash);
    if (idx === -1) return false;
    hashes.splice(idx, 1);
    this.store.settings.set(TOTP_RECOVERY_KEY, JSON.stringify(hashes));
    return true;
  }

  private checkLocked(ip: string, now: number): number {
    let maxUntil = 0;
    for (const key of [`ip:${ip}`, "global"]) {
      const row = this.store.security.getThrottle(key);
      if (!row) continue;
      if (row.lockedUntil > now) maxUntil = Math.max(maxUntil, row.lockedUntil);
      else if (now - row.updatedAt > WINDOW_RESET_MS) this.store.security.deleteThrottle(key);
    }
    return maxUntil > now ? Math.max(1, Math.ceil((maxUntil - now) / 1000)) : 0;
  }

  private recordFailure(ip: string, now: number): number {
    const bump = (key: string, softLimit: number, hardLimit: number): number => {
      const existing = this.store.security.getThrottle(key);
      const stale = !existing || (existing.lockedUntil <= now && now - existing.updatedAt > WINDOW_RESET_MS);
      const attempts = stale ? 1 : existing.attempts + 1;
      let lockedUntil = stale ? 0 : existing.lockedUntil;
      if (attempts >= hardLimit) lockedUntil = now + HARD_LOCK_MS;
      else if (attempts >= softLimit) lockedUntil = now + SOFT_LOCK_MS;
      this.store.security.setThrottle({ key, attempts, lockedUntil, updatedAt: now });
      return attempts;
    };
    const ipAttempts = bump(`ip:${ip}`, IP_SOFT_LIMIT, IP_HARD_LIMIT);
    bump("global", GLOBAL_SOFT_LIMIT, GLOBAL_HARD_LIMIT);
    // Progressive tarpit: 250ms, 500ms, 1000ms, 2000ms, capped at 4000ms.
    return Math.min(4000, 250 * 2 ** Math.min(4, Math.max(0, ipAttempts - 1)));
  }

  private clearThrottle(ip: string): void {
    this.store.security.deleteThrottle(`ip:${ip}`);
    this.store.security.deleteThrottle("global");
  }
}
