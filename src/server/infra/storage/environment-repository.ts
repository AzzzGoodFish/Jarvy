import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentKind, EnvironmentRecord } from "../../shared/environment.js";

interface Row { id: string; ownerId: string; kind: EnvironmentKind; botId: string | null; connection: string }
const COLUMNS = "id, owner_id AS ownerId, kind, bot_id AS botId, connection";
const record = (row: Row): EnvironmentRecord => ({ id: row.id, ownerId: row.ownerId, kind: row.kind, botId: row.botId, spec: JSON.parse(row.connection) as Record<string, string> });

/** Work environments and where each Bot works (v20, A50). A Bot's home or current environment left NULL is its
 * owner's computer, whose row is made when first needed. */
export class EnvironmentRepository {
  constructor(private readonly db: DatabaseSync, private readonly ownerId: () => string) {}

  get(id: string): EnvironmentRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM environments WHERE id=? AND deleted_at IS NULL`).get(id) as Row | undefined;
    return row ? record(row) : null;
  }
  /** The owner's computer. */
  host(): EnvironmentRecord {
    const owner = this.ownerId();
    const find = () => this.db.prepare(`SELECT ${COLUMNS} FROM environments WHERE owner_id=? AND kind='host' AND deleted_at IS NULL`).get(owner) as Row | undefined;
    const found = find();
    if (found) return record(found);
    this.db.prepare("INSERT OR IGNORE INTO environments(id,owner_id,kind,created_at) VALUES(?,?,'host',?)").run(randomUUID(), owner, Date.now());
    return record(find()!);
  }
  computerOf(botId: string): EnvironmentRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM environments WHERE bot_id=? AND kind='computer' AND deleted_at IS NULL`).get(botId) as Row | undefined;
    return row ? record(row) : null;
  }
  /** Every live Bot's computer. */
  computers(): EnvironmentRecord[] {
    return (this.db.prepare(`SELECT e.id, e.owner_id AS ownerId, e.kind, e.bot_id AS botId, e.connection FROM environments e JOIN bots b ON b.id=e.bot_id
      WHERE e.kind='computer' AND e.deleted_at IS NULL AND b.deleted_at IS NULL`).all() as unknown as Row[]).map(record);
  }
  /** Gives the Bot a computer, reached by the container's name. */
  addComputer(botId: string, container: string): EnvironmentRecord {
    const existing = this.computerOf(botId);
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare("INSERT INTO environments(id,owner_id,kind,connection,directory,bot_id,created_at) VALUES(?,?,'computer',?,'/workspace',?,?)")
      .run(id, this.ownerId(), JSON.stringify({ container }), botId, Date.now());
    return this.get(id)!;
  }
  /** The Bot's computer is gone: whoever was placed on it is back on the owner's computer. */
  dropComputer(botId: string): void {
    const computer = this.computerOf(botId);
    if (!computer) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE bots SET home_environment_id=NULL WHERE home_environment_id=?").run(computer.id);
      this.db.prepare("UPDATE bots SET current_environment_id=NULL WHERE current_environment_id=?").run(computer.id);
      this.db.prepare("DELETE FROM environment_grants WHERE environment_id=?").run(computer.id);
      this.db.prepare("UPDATE environments SET deleted_at=? WHERE id=?").run(Date.now(), computer.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** The Bot's default environment and the one it works in now. */
  placement(botId: string): { home: EnvironmentRecord; current: EnvironmentRecord } {
    const row = this.db.prepare("SELECT home_environment_id AS home, current_environment_id AS current FROM bots WHERE id=?").get(botId) as { home: string | null; current: string | null } | undefined;
    const home = (row?.home && this.get(row.home)) || this.host();
    const current = (row?.current && this.get(row.current)) || home;
    return { home, current };
  }
  /** Makes an environment the Bot's default and moves the Bot there. */
  setHome(botId: string, environmentId: string): void {
    this.db.prepare("UPDATE bots SET home_environment_id=?, current_environment_id=? WHERE id=?").run(environmentId, environmentId, botId);
  }
}
