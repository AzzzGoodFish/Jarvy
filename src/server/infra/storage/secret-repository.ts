import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { SECRET_FIELD_KEY, SECRET_NAME } from "../../shared/secret.js";
import {
  SECRET_CATEGORIES, type GrantScope, type Secret, type SecretCategory, type SecretField, type SecretFieldInput, type SecretUse,
} from "../../../contract/secrets.js";
import type { Cipher } from "../vault/cipher.js";

type StoredField =
  | { key: string; label?: string; secret: false; value: string }
  | { key: string; label?: string; secret: true; value: string; fingerprint: string };

type Row = {
  id: string; name: string; kind: Secret["kind"]; category: SecretCategory; fieldsJson: string;
  botId: string | null; description: string; value: string; fingerprint: string;
  createdAt: number; updatedAt: number; uses: number; lastUsedAt: number | null;
};
const COLUMNS = `s.id, s.name, s.kind, s.category, s.fields_json AS fieldsJson, s.bot_id AS botId, s.description, s.value, s.fingerprint, s.created_at AS createdAt, s.updated_at AS updatedAt,
  (SELECT count(*) FROM secret_uses u WHERE u.secret_id=s.id) AS uses, (SELECT max(at) FROM secret_uses u WHERE u.secret_id=s.id) AS lastUsedAt`;
const MAX_VALUE = 16 * 1024;
const MAX_PUBLIC_VALUE = 500;
const MAX_FIELDS = 16;
const MAX_LABEL = 60;
const CONTROL_CHARS = /[\x00-\x1f]/u;
const CATEGORY_SET = new Set<string>(SECRET_CATEGORIES);

const fieldContext = (secretId: string, key: string) => `secret:${secretId}:${key}`;

/** Validates a secret category (v36). Empty/omitted defaults to `other`. */
export function checkSecretCategory(value: unknown): SecretCategory {
  if (value === undefined || value === null || value === "") return "other";
  if (typeof value !== "string" || !CATEGORY_SET.has(value)) {
    throw new ValidationError("Category must be login, api_key, database or other", "secret_category_invalid");
  }
  return value as SecretCategory;
}

/** Validates an array of field specs for `secrets.request` hints (strips any value on `secret: true` fields). */
export function checkSecretFieldHints(raw: unknown): SecretFieldInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS) {
    throw new ValidationError(`At most ${MAX_FIELDS} fields are allowed`, "secret_fields_invalid");
  }
  const seen = new Set<string>();
  const out: SecretFieldInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidationError("Invalid field entry", "secret_fields_invalid");
    }
    const entry = item as Record<string, unknown>;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!SECRET_FIELD_KEY.test(key)) {
      throw new ValidationError("Field keys use letters, digits and underscores, starting with a letter", "secret_fields_invalid");
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw new ValidationError(`Duplicate field key "${key}"`, "secret_fields_invalid");
    seen.add(lower);
    if (typeof entry.secret !== "boolean") throw new ValidationError("Field secret flag must be a boolean", "secret_fields_invalid");
    let label: string | undefined;
    if (entry.label !== undefined && entry.label !== null && entry.label !== "") {
      if (typeof entry.label !== "string" || entry.label.length > MAX_LABEL || CONTROL_CHARS.test(entry.label)) {
        throw new ValidationError("Field label must be one line of up to 60 characters", "secret_fields_invalid");
      }
      label = entry.label.trim() || undefined;
    }
    if (entry.secret) {
      out.push({ key, ...(label ? { label } : {}), secret: true });
    } else {
      const val = validatePublicFieldValue(key, entry.value);
      out.push({ key, ...(label ? { label } : {}), secret: false, ...(val ? { value: val } : {}) });
    }
  }
  return out;
}

function validatePublicFieldValue(key: string, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string" || raw.length > MAX_PUBLIC_VALUE || CONTROL_CHARS.test(raw)) {
    throw new ValidationError(`Field "${key}" must be one line of up to ${MAX_PUBLIC_VALUE} characters`, "secret_fields_invalid");
  }
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.password) {
      throw new ValidationError(`Do not include a password in non-secret field "${key}"`, "secret_fields_invalid");
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
  }
  return trimmed;
}

function parseStoredFields(json: string): StoredField[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as StoredField[] : [];
  } catch {
    return [];
  }
}

/** Secrets, their grants and their uses (v21, v36, A52). Primary and secret-field values are sealed under the master
 * key, bound to the secret's id (and field key). */
export class SecretRepository {
  constructor(private readonly db: DatabaseSync, private readonly cipher: Cipher, private readonly ownerId: () => string) {}

  private publicFields(secretId: string, stored: readonly StoredField[]): SecretField[] {
    return stored.map(field => field.secret
      ? {
          key: field.key,
          ...(field.label ? { label: field.label } : {}),
          secret: true,
          fingerprint: field.fingerprint,
          readable: this.cipher.open(field.value, fieldContext(secretId, field.key)) !== null,
        }
      : {
          key: field.key,
          ...(field.label ? { label: field.label } : {}),
          secret: false,
          value: field.value,
        });
  }

  private toRecord(row: Row): Secret {
    const grants = (this.db.prepare(`SELECT bot_id AS botId, scope, granted_at AS grantedAt FROM secret_grants g WHERE secret_id=?
      AND (scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL)) ORDER BY granted_at`)
      .all(row.id) as unknown as Secret["grants"]).map(grant => ({ ...grant }));
    const { value, fieldsJson, ...rest } = row;
    const fields = this.publicFields(row.id, parseStoredFields(fieldsJson));
    return { ...rest, fields, readable: this.cipher.open(value, `secret:${row.id}`) !== null, grants };
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

  private encodeFields(secretId: string, raw: unknown, existing: readonly StoredField[]): StoredField[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_FIELDS) {
      throw new ValidationError(`At most ${MAX_FIELDS} fields are allowed`, "secret_fields_invalid");
    }
    const priorByKey = new Map(existing.map(item => [item.key, item]));
    const seenLower = new Set<string>();
    const out: StoredField[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ValidationError("Invalid field entry", "secret_fields_invalid");
      }
      const entry = item as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!SECRET_FIELD_KEY.test(key)) {
        throw new ValidationError("Field keys use letters, digits and underscores, starting with a letter", "secret_fields_invalid");
      }
      const lower = key.toLowerCase();
      if (seenLower.has(lower)) throw new ValidationError(`Duplicate field key "${key}"`, "secret_fields_invalid");
      seenLower.add(lower);
      if (typeof entry.secret !== "boolean") throw new ValidationError("Field secret flag must be a boolean", "secret_fields_invalid");
      let label: string | undefined;
      if (entry.label !== undefined && entry.label !== null && entry.label !== "") {
        if (typeof entry.label !== "string" || entry.label.length > MAX_LABEL || CONTROL_CHARS.test(entry.label)) {
          throw new ValidationError("Field label must be one line of up to 60 characters", "secret_fields_invalid");
        }
        label = entry.label.trim() || undefined;
      }

      if (entry.secret) {
        const plain = typeof entry.value === "string" ? entry.value : "";
        if (plain.length > MAX_VALUE) throw new ValidationError("The value is too long", "secret_value_too_long");
        if (plain) {
          out.push({
            key, ...(label ? { label } : {}), secret: true,
            value: this.cipher.seal(plain, fieldContext(secretId, key)),
            fingerprint: this.cipher.fingerprint(plain),
          });
        } else {
          const prior = priorByKey.get(key);
          if (prior && prior.secret) {
            out.push({ key, ...(label ? { label } : {}), secret: true, value: prior.value, fingerprint: prior.fingerprint });
          } else {
            throw new ValidationError(`Secret field "${key}" needs a value`, "secret_fields_invalid");
          }
        }
      } else {
        const val = validatePublicFieldValue(key, entry.value);
        if (val) out.push({ key, ...(label ? { label } : {}), secret: false, value: val });
      }
    }
    return out;
  }

  create(input: { name: unknown; category?: unknown; fields?: unknown; description?: unknown; value: unknown }): Secret {
    if (typeof input.name !== "string" || !SECRET_NAME.test(input.name)) throw new ValidationError("Names use capital letters, digits and underscores, and start with a letter", "secret_name_invalid");
    const category = checkSecretCategory(input.category);
    const description = this.checkDescription(input.description), value = this.checkValue(input.value);
    if (this.db.prepare("SELECT 1 FROM secrets WHERE owner_id=? AND kind='value' AND name=?").get(this.ownerId(), input.name)) throw new ConflictError("Another secret has this name", "secret_name_taken");
    const id = randomUUID(), now = Date.now();
    const fields = this.encodeFields(id, input.fields, []);
    this.db.prepare("INSERT INTO secrets(id,owner_id,name,kind,category,fields_json,bot_id,description,value,fingerprint,created_at,updated_at) VALUES(?,?,?,'value',?,?,NULL,?,?,?,?,?)")
      .run(id, this.ownerId(), input.name, category, JSON.stringify(fields), description, this.cipher.seal(value, `secret:${id}`), this.cipher.fingerprint(value), now, now);
    return this.get(id)!;
  }

  update(id: string, input: { category?: unknown; fields?: unknown; description?: unknown; value?: unknown }): Secret | null {
    const existingRow = this.db.prepare("SELECT id, fields_json AS fieldsJson FROM secrets WHERE id=? AND owner_id=?")
      .get(id, this.ownerId()) as { id: string; fieldsJson: string } | undefined;
    if (!existingRow) return null;
    // Validate and seal every supplied field before touching SQLite so a failed save never persists partial changes.
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (input.category !== undefined) {
      sets.push("category=?");
      params.push(checkSecretCategory(input.category));
    }
    if (input.fields !== undefined) {
      const encoded = this.encodeFields(id, input.fields, parseStoredFields(existingRow.fieldsJson));
      sets.push("fields_json=?");
      params.push(JSON.stringify(encoded));
    }
    if (input.description !== undefined) {
      sets.push("description=?");
      params.push(this.checkDescription(input.description));
    }
    if (input.value !== undefined) {
      const value = this.checkValue(input.value);
      sets.push("value=?", "fingerprint=?");
      params.push(this.cipher.seal(value, `secret:${id}`), this.cipher.fingerprint(value));
    }
    if (sets.length) {
      sets.push("updated_at=?");
      params.push(Date.now(), id, this.ownerId());
      this.db.prepare(`UPDATE secrets SET ${sets.join(", ")} WHERE id=? AND owner_id=?`).run(...params);
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

  /** Every sealed value the owner keeps that opens (primary values and every `secret: true` field), for masking. */
  values(): { name: string; value: string }[] {
    const rows = this.db.prepare("SELECT id, name, value, fields_json AS fieldsJson FROM secrets WHERE owner_id=? AND kind='value'")
      .all(this.ownerId()) as { id: string; name: string; value: string; fieldsJson: string }[];
    const out: { name: string; value: string }[] = [];
    for (const row of rows) {
      const primary = this.cipher.open(row.value, `secret:${row.id}`);
      if (primary !== null) out.push({ name: row.name, value: primary });
      for (const field of parseStoredFields(row.fieldsJson)) {
        if (!field.secret) continue;
        const opened = this.cipher.open(field.value, fieldContext(row.id, field.key));
        if (opened !== null) out.push({ name: `${row.name}.${field.key}`, value: opened });
      }
    }
    return out;
  }

  /** The secrets a Bot may use: granted until revoked, or for the run that is still going. */
  grantedTo(botId: string): { id: string; name: string; description: string; scope: GrantScope }[] {
    return (this.db.prepare(`SELECT s.id, s.name, s.description, g.scope FROM secrets s JOIN secret_grants g ON g.secret_id=s.id
      WHERE g.bot_id=? AND s.owner_id=? AND s.kind='value' AND (g.scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL))
      ORDER BY s.name`).all(botId, this.ownerId()) as { id: string; name: string; description: string; scope: GrantScope }[]).map(row => ({ ...row }));
  }
  currentRun(botId: string): string | null {
    return (this.db.prepare("SELECT id FROM bot_runs WHERE bot_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1").get(botId) as { id: string } | undefined)?.id ?? null;
  }
  byName(name: string): Secret | null {
    const row = this.db.prepare("SELECT id FROM secrets WHERE owner_id=? AND kind='value' AND name=?").get(this.ownerId(), name) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }
  private purge(): void {
    this.db.prepare("DELETE FROM secret_grants WHERE scope='once' AND NOT EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=secret_grants.run_id AND r.ended_at IS NULL)").run();
  }
  record(use: { secretId: string; name: string; botId: string; how: "command" | "ssh_sign"; environmentId: string | null; toolCallId: string | null; detail: string }): void {
    this.db.prepare("INSERT INTO secret_uses(secret_id,secret_name,bot_id,at,how,environment_id,tool_call_id,detail) VALUES(?,?,?,?,?,?,?,?)")
      .run(use.secretId, use.name, use.botId, Date.now(), use.how, use.environmentId, use.toolCallId, use.detail.slice(0, 4000));
  }
  /** The plain primary value, for a command that uses it; null when it does not open. */
  value(id: string): string | null {
    const row = this.db.prepare("SELECT value FROM secrets WHERE id=?").get(id) as { value: string } | undefined;
    return row ? this.cipher.open(row.value, `secret:${id}`) : null;
  }
  /** The plain value of one encrypted custom field (`secret: true`), for `{{secret:NAME.FIELD}}` resolution. */
  fieldValue(id: string, fieldKey: string): string | null {
    const row = this.db.prepare("SELECT fields_json AS fieldsJson FROM secrets WHERE id=?").get(id) as { fieldsJson: string } | undefined;
    if (!row) return null;
    const found = parseStoredFields(row.fieldsJson).find(field => field.secret && field.key === fieldKey);
    return found ? this.cipher.open(found.value, fieldContext(id, found.key)) : null;
  }
}
