import type { DatabaseSync } from "node:sqlite";
import { RuntimeFault } from "../../shared/runtime.js";
import { Cipher } from "../vault/cipher.js";
import { transaction } from "./transaction.js";

export type StoredCredential = { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown };
export function credentialValue(value: unknown): StoredCredential {
  if (!value || typeof value !== "object") throw new RuntimeFault("invalid_credential", "The credential format isn't valid.");
  const v = value as Record<string, unknown>;
  if (v.type === "api_key" && (typeof v.key === "string" || (v.env && typeof v.env === "object"))) {
    if (v.env && (Array.isArray(v.env) || Object.values(v.env).some(item => typeof item !== "string"))) throw new RuntimeFault("invalid_credential", "The credential format isn't valid.");
    return structuredClone(v) as StoredCredential;
  }
  if (v.type === "oauth" && typeof v.access === "string" && typeof v.refresh === "string" && typeof v.expires === "number" && Number.isFinite(v.expires))
    return structuredClone(v) as StoredCredential;
  throw new RuntimeFault("invalid_credential", "The credential format isn't valid.");
}
/** Model credentials, encrypted under the master key since v21 (A52). The stored text doubles as the revision. */
export class CredentialRepository {
  constructor(private readonly db: DatabaseSync, private readonly cipher: Cipher) {}
  /** The text to store for a credential. */
  stored(connectionId: string, value: StoredCredential): string { return this.cipher.seal(JSON.stringify(credentialValue(value)), `credential:${connectionId}`); }
  /** Like `read`, but a value that doesn't open under this installation's key comes back as null, so it can be replaced. */
  current(ownerId: string, connectionId: string): { value: StoredCredential | null; revision: string } | null {
    const row = this.db.prepare(`SELECT p.credential_json AS json FROM provider_credentials p JOIN provider_connections c ON c.id=p.connection_id
      WHERE c.id=? AND c.owner_id=?`).get(connectionId, ownerId) as { json: string } | undefined;
    if (!row) return null;
    const plain = Cipher.sealed(row.json) ? this.cipher.open(row.json, `credential:${connectionId}`) : row.json;
    return { value: plain === null ? null : credentialValue(JSON.parse(plain)), revision: row.json };
  }
  read(ownerId: string, connectionId: string): { value: StoredCredential; revision: string } | null {
    const row = this.current(ownerId, connectionId);
    if (row && !row.value) throw new RuntimeFault("credential_unreadable", "The saved credential can't be decrypted with this installation's master key; enter it again in Settings.");
    return row as { value: StoredCredential; revision: string } | null;
  }
  replace(ownerId: string, connectionId: string, prior: string | null, value: StoredCredential): void {
    const next = this.stored(connectionId, value);
    transaction(this.db, () => {
      if (!this.db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND owner_id=?").get(connectionId, ownerId))
        throw new RuntimeFault("connection_missing", "Connection not found", 404);
      const current = this.current(ownerId, connectionId);
      if ((current?.revision ?? null) !== prior) throw new RuntimeFault("credential_changed", "The credential changed. Please try again.");
      this.db.prepare(`INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(connection_id) DO UPDATE SET type=excluded.type,credential_json=excluded.credential_json,updated_at=excluded.updated_at`)
        .run(connectionId, value.type, next, Date.now());
    });
  }
  delete(ownerId: string, connectionId: string): void {
    this.db.prepare("DELETE FROM provider_credentials WHERE connection_id=? AND connection_id IN (SELECT id FROM provider_connections WHERE owner_id=?)").run(connectionId, ownerId);
  }
}

