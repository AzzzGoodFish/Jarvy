import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { requireText } from "./text.js";
import { transaction } from "./transaction.js";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
function passwordHash(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
}
function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/** The one account (its name and password), its sign-in sessions, the owner's member id, and this installation's id. */
export class AccountRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Installation identity, not an account/connection ID. Pi requests it only for ChatGPT login. */
  installationDeviceId(): string {
    const row = this.db.prepare("SELECT device_id FROM installation WHERE id=1").get() as { device_id: string } | undefined;
    if (row) return row.device_id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO installation(id,device_id) VALUES(1,?)").run(id);
    return id;
  }
  userMemberId(): string {
    const account = this.db.prepare("SELECT member_id AS id FROM account WHERE id=1").get() as { id: string } | undefined;
    // Before account initialization, migrations have reserved one owner identity.
    return account?.id ?? (this.db.prepare("SELECT id FROM members WHERE kind='user' ORDER BY rowid LIMIT 1").get() as { id: string }).id;
  }
  isInitialized(): boolean { return !!this.db.prepare("SELECT 1 FROM account WHERE id=1").get(); }
  username(): string | null {
    return (this.db.prepare("SELECT username FROM account WHERE id=1").get() as { username: string } | undefined)?.username ?? null;
  }
  initialize(username: unknown, password: unknown): void {
    const name = requireText(username, "Username", 64);
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new ValidationError("Password must be 8-256 characters");
    const salt = randomBytes(16).toString("hex");
    const digest = passwordHash(password, salt);
    transaction(this.db, () => {
      if (this.isInitialized()) throw new ConflictError("Account is already initialized");
      this.db.prepare("INSERT INTO account(id,username,password_salt,password_hash,member_id) VALUES(1,?,?,?,?)").run(name, salt, digest, this.userMemberId());
    });
  }
  login(username: unknown, password: unknown): string | null {
    const row = this.db.prepare("SELECT username,password_salt,password_hash FROM account WHERE id=1").get() as
      { username: string; password_salt: string; password_hash: string } | undefined;
    if (!row || typeof username !== "string" || typeof password !== "string") return null;
    const candidate = Buffer.from(passwordHash(password, row.password_salt), "hex");
    const expected = Buffer.from(row.password_hash, "hex");
    if (!timingSafeEqual(candidate, expected) || username !== row.username) return null;
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at<?").run(Date.now());
    this.db.prepare("INSERT INTO auth_sessions VALUES (?,?)").run(tokenHash(token), Date.now() + SESSION_LIFETIME_MS);
    return token;
  }
  authenticated(token: string | undefined): boolean {
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return false;
    return !!this.db.prepare("SELECT 1 FROM auth_sessions WHERE token_hash=? AND expires_at>?").get(tokenHash(token), Date.now());
  }
  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenHash(token));
  }
}
