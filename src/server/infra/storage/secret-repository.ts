import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { SECRET_NAME } from "../../shared/secret.js";
import { type GrantScope, type Secret, type SecretUse } from "../../../contract/secrets.js";
import type { Cipher } from "../vault/cipher.js";

type Row = { id: string; name: string; kind: Secret["kind"]; botId: string | null; description: string; value: string; fingerprint: string;
  createdAt: number; updatedAt: number; uses: number; lastUsedAt: number | null };
const COLUMNS = `s.id, s.name, s.kind, s.bot_id AS botId, s.description, s.value, s.fingerprint, s.created_at AS createdAt, s.updated_at AS updatedAt,
  (SELECT count(*) FROM secret_uses u WHERE u.secret_id=s.id) AS uses, (SELECT max(at) FROM secret_uses u WHERE u.secret_id=s.id) AS lastUsedAt`;
const MAX_VALUE = 16 * 1024;

/** Secrets, their grants and their uses (v21, A52). Values are sealed under the master key, bound to the secret's id. */
export class SecretRepository {
  constructor(private readonly db: DatabaseSync, private readonly cipher: Cipher, private readonly ownerId: () => string) {}
  private toRecord(row: Row): Secret {
    const grants = (this.db.prepare(`SELECT bot_id AS botId, scope, granted_at AS grantedAt FROM secret_grants g WHERE secret_id=?
      AND (scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL)) ORDER BY granted_at`)
      .all(row.id) as unknown as Secret["grants"]).map(grant => ({ ...grant }));
    const { value, ...rest } = row;
    return { ...rest, readable: this.cipher.open(value, `secret:${row.id}`) !== null, grants };
  }
  list(): Secret[] {
    this.purge();
    return (this.db.prepare(`SELECT ${COLUMNS} FROM secrets s WHERE s.owner_id=? ORDER BY s.kind, lower(s.name)`).all(this.ownerId()) as unknown as Row[]).map(row => this.toRecord(row));
  }
  get(id: string): Secret | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM secrets s WHERE s.id=? AND s.owner_id=?`).get(id, this.ownerId()) as unknown as Row | undefined;
    return row ? this.toRecord(row) : null;
  }
  private checkValue(value: unknown): string {
    if (typeof value !== "string" || !value) throw new ValidationError("A secret needs a value", "secret_value_missing");
    if (value.length > MAX_VALUE) throw new ValidationError("The value is too long", "secret_value_too_long");
    return value;
  }
  private checkDescription(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > 200 || /[\n\r]/.test(value)) throw new ValidationError("The description must be one line of up to 200 characters", "secret_description_invalid");
    return value.trim();
  }
  create(input: { name: unknown; description?: unknown; value: unknown }): Secret {
    if (typeof input.name !== "string" || !SECRET_NAME.test(input.name)) throw new ValidationError("Names use capital letters, digits and underscores, and start with a letter", "secret_name_invalid");
    const description = this.checkDescription(input.description), value = this.checkValue(input.value);
    if (this.db.prepare("SELECT 1 FROM secrets WHERE owner_id=? AND kind='value' AND name=?").get(this.ownerId(), input.name)) throw new ConflictError("Another secret has this name", "secret_name_taken");
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO secrets(id,owner_id,name,kind,bot_id,description,value,fingerprint,created_at,updated_at) VALUES(?,?,?,'value',NULL,?,?,?,?,?)")
      .run(id, this.ownerId(), input.name, description, this.cipher.seal(value, `secret:${id}`), this.cipher.fingerprint(value), now, now);
    return this.get(id)!;
  }
  update(id: string, input: { description?: unknown; value?: unknown }): Secret | null {
    if (!this.get(id)) return null;
    if (input.description !== undefined) this.db.prepare("UPDATE secrets SET description=?, updated_at=? WHERE id=?").run(this.checkDescription(input.description), Date.now(), id);
    if (input.value !== undefined) {
      const value = this.checkValue(input.value);
      this.db.prepare("UPDATE secrets SET value=?, fingerprint=?, updated_at=? WHERE id=?").run(this.cipher.seal(value, `secret:${id}`), this.cipher.fingerprint(value), Date.now(), id);
    }
    return this.get(id);
  }
  /** The grants go with it; its uses stay, under its name. */
  delete(id: string): boolean { return Number(this.db.prepare("DELETE FROM secrets WHERE id=? AND owner_id=?").run(id, this.ownerId()).changes) > 0; }
  grant(id: string, botId: string, scope: GrantScope, runId: string | null): void {
    this.db.prepare(`INSERT INTO secret_grants(secret_id,bot_id,scope,run_id,granted_by,granted_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(secret_id,bot_id) DO UPDATE SET scope=excluded.scope, run_id=excluded.run_id, granted_at=excluded.granted_at`).run(id, botId, scope, runId, this.ownerId(), Date.now());
  }
  revoke(id: string, botId: string): boolean { return Number(this.db.prepare("DELETE FROM secret_grants WHERE secret_id=? AND bot_id=?").run(id, botId).changes) > 0; }
  uses(id: string, limit = 100): SecretUse[] {
    return (this.db.prepare(`SELECT id, secret_name AS secretName, bot_id AS botId, at, how, environment_id AS environmentId, history_id AS historyId,
      tool_call_id AS toolCallId, detail FROM secret_uses WHERE secret_id=? ORDER BY at DESC, id DESC LIMIT ?`).all(id, limit) as unknown as SecretUse[]).map(use => ({ ...use }));
  }
  /** Every value the owner keeps that opens, for masking. */
  values(): { name: string; value: string }[] {
    return (this.db.prepare("SELECT id, name, value FROM secrets WHERE owner_id=? AND kind='value'").all(this.ownerId()) as { id: string; name: string; value: string }[])
      .map(row => ({ name: row.name, value: this.cipher.open(row.value, `secret:${row.id}`) })).filter((row): row is { name: string; value: string } => row.value !== null);
  }
  /** The secrets a Bot may use: granted until revoked, or for the run that is still going. */
  grantedTo(botId: string): { id: string; name: string; description: string; scope: GrantScope }[] {
    return (this.db.prepare(`SELECT s.id, s.name, s.description, g.scope FROM secrets s JOIN secret_grants g ON g.secret_id=s.id
      WHERE g.bot_id=? AND s.owner_id=? AND s.kind='value' AND (g.scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL))
      ORDER BY s.name`).all(botId, this.ownerId()) as { id: string; name: string; description: string; scope: GrantScope }[]).map(row => ({ ...row }));
  }
  /** The Bot's run in progress, which a "this time only" grant lasts for. */
  currentRun(botId: string): string | null {
    return (this.db.prepare("SELECT id FROM bot_runs WHERE bot_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1").get(botId) as { id: string } | undefined)?.id ?? null;
  }
  byName(name: string): Secret | null {
    const row = this.db.prepare("SELECT id FROM secrets WHERE owner_id=? AND kind='value' AND name=?").get(this.ownerId(), name) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }
  /** "This time only" grants whose run has ended. */
  private purge(): void {
    this.db.prepare("DELETE FROM secret_grants WHERE scope='once' AND NOT EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=secret_grants.run_id AND r.ended_at IS NULL)").run();
  }
  record(use: { secretId: string; name: string; botId: string; how: "command" | "ssh_sign"; environmentId: string | null; toolCallId: string | null; detail: string }): void {
    this.db.prepare("INSERT INTO secret_uses(secret_id,secret_name,bot_id,at,how,environment_id,tool_call_id,detail) VALUES(?,?,?,?,?,?,?,?)")
      .run(use.secretId, use.name, use.botId, Date.now(), use.how, use.environmentId, use.toolCallId, use.detail.slice(0, 4000));
  }
  /** The plain value, for a command that uses it; null when it does not open. */
  value(id: string): string | null {
    const row = this.db.prepare("SELECT value FROM secrets WHERE id=?").get(id) as { value: string } | undefined;
    return row ? this.cipher.open(row.value, `secret:${id}`) : null;
  }
}
