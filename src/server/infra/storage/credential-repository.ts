import type { DatabaseSync } from "node:sqlite";
import { RuntimeFault } from "../../shared/runtime.js";

export type StoredCredential = { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown };
export function credentialValue(value: unknown): StoredCredential {
  if (!value || typeof value !== "object") throw new RuntimeFault("invalid_credential", "凭证格式无效。");
  const v = value as Record<string, unknown>;
  if (v.type === "api_key" && (typeof v.key === "string" || (v.env && typeof v.env === "object"))) {
    if (v.env && (Array.isArray(v.env) || Object.values(v.env).some(item => typeof item !== "string"))) throw new RuntimeFault("invalid_credential", "凭证格式无效。");
    return structuredClone(v) as StoredCredential;
  }
  if (v.type === "oauth" && typeof v.access === "string" && typeof v.refresh === "string" && typeof v.expires === "number" && Number.isFinite(v.expires))
    return structuredClone(v) as StoredCredential;
  throw new RuntimeFault("invalid_credential", "凭证格式无效。");
}
export class CredentialRepository {
  constructor(private readonly db: DatabaseSync) {}
  read(ownerId: string, connectionId: string): { value: StoredCredential; revision: string } | null {
    const row = this.db.prepare(`SELECT p.credential_json AS json FROM provider_credentials p JOIN provider_connections c ON c.id=p.connection_id
      WHERE c.id=? AND c.owner_id=?`).get(connectionId, ownerId) as { json: string } | undefined;
    return row ? { value: credentialValue(JSON.parse(row.json)), revision: row.json } : null;
  }
  replace(ownerId: string, connectionId: string, prior: string | null, value: StoredCredential): void {
    const next = JSON.stringify(credentialValue(value));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND owner_id=?").get(connectionId, ownerId))
        throw new RuntimeFault("connection_missing", "模型连接不存在。", 404);
      const current = this.read(ownerId, connectionId);
      if ((current?.revision ?? null) !== prior) throw new RuntimeFault("credential_changed", "凭证已更改，请重试。");
      this.db.prepare(`INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(connection_id) DO UPDATE SET type=excluded.type,credential_json=excluded.credential_json,updated_at=excluded.updated_at`)
        .run(connectionId, value.type, next, Date.now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  delete(ownerId: string, connectionId: string): void {
    this.db.prepare("DELETE FROM provider_credentials WHERE connection_id=? AND connection_id IN (SELECT id FROM provider_connections WHERE owner_id=?)").run(connectionId, ownerId);
  }
}

