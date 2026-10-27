import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentKind, EnvironmentRecord, HostKeys } from "../../shared/environment.js";
import type { Cipher } from "../vault/cipher.js";
import { transaction } from "./transaction.js";

interface Row { id: string; ownerId: string; kind: EnvironmentKind; botId: string | null; name: string; directory: string | null; connection: string }
const FIELDS = (table: string) => ["id", "owner_id AS ownerId", "kind", "bot_id AS botId", "name", "directory", "connection"].map(column => `${table}${column}`).join(", ");
const COLUMNS = FIELDS("");
const record = (row: Row): EnvironmentRecord => ({ id: row.id, ownerId: row.ownerId, kind: row.kind, botId: row.botId, name: row.name, directory: row.directory,
  spec: JSON.parse(row.connection) as Record<string, string> });
/** What a new SSH machine is saved with (A57); `password` only for one that refuses Jarvy's key (A59). */
export interface NewSshMachine { name: string; host: string; port: number; user: string; home: string; platform: string; directory: string; hostKeys: HostKeys; privateKey: string; password?: string }

/** Work environments and where each Bot works (v20, A50). A Bot's home or current environment left NULL is its
 * owner's computer, whose row is made when first needed. SSH machines (v22, A57) keep their key sealed under the
 * master key. */
export class EnvironmentRepository {
  constructor(private readonly db: DatabaseSync, private readonly cipher: Cipher, private readonly ownerId: () => string) {}

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
    return (this.db.prepare(`SELECT ${FIELDS("e.")} FROM environments e JOIN bots b ON b.id=e.bot_id
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
    transaction(this.db, () => {
      this.db.prepare("UPDATE bots SET home_environment_id=NULL WHERE home_environment_id=?").run(computer.id);
      this.db.prepare("UPDATE bots SET current_environment_id=NULL WHERE current_environment_id=?").run(computer.id);
      this.db.prepare("DELETE FROM environment_grants WHERE environment_id=?").run(computer.id);
      this.db.prepare("UPDATE environments SET deleted_at=? WHERE id=?").run(Date.now(), computer.id);
    });
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
  /** Moves the Bot without changing its default. */
  setCurrent(botId: string, environmentId: string): void {
    this.db.prepare("UPDATE bots SET current_environment_id=? WHERE id=?").run(environmentId, botId);
  }
  /** The environments the owner granted the Bot, oldest grant first. */
  grants(botId: string): EnvironmentRecord[] {
    return (this.db.prepare(`SELECT ${FIELDS("e.")} FROM environment_grants g JOIN environments e ON e.id=g.environment_id
      WHERE g.bot_id=? AND e.deleted_at IS NULL ORDER BY g.granted_at, e.id`).all(botId) as unknown as Row[]).map(record);
  }
  /** A grant lasts until it is revoked (A50); false when nothing changed. */
  grant(environmentId: string, botId: string, by: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO environment_grants(environment_id,bot_id,granted_by,granted_at) VALUES(?,?,?,?)")
      .run(environmentId, botId, by, Date.now()).changes) > 0;
  }
  revoke(environmentId: string, botId: string): boolean {
    return Number(this.db.prepare("DELETE FROM environment_grants WHERE environment_id=? AND bot_id=?").run(environmentId, botId).changes) > 0;
  }
  /** The SSH machines, oldest first. */
  sshMachines(): EnvironmentRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM environments WHERE kind='ssh' AND deleted_at IS NULL ORDER BY created_at, id`).all() as unknown as Row[]).map(record);
  }
  addSsh(input: NewSshMachine, id: string = randomUUID()): EnvironmentRecord {
    const { host, port, user, home, platform } = input;
    this.db.prepare("INSERT INTO environments(id,owner_id,kind,name,connection,directory,key,host_keys,password,created_at) VALUES(?,?,'ssh',?,?,?,?,?,?,?)")
      .run(id, this.ownerId(), input.name, JSON.stringify({ host, port: String(port), user, home, platform }), input.directory,
        this.cipher.seal(input.privateKey, `environment:${id}`), JSON.stringify(input.hostKeys),
        input.password ? this.cipher.seal(input.password, `environment-password:${id}`) : null, Date.now());
    return this.get(id)!;
  }
  /** `password`: a new one for a machine reached with its password; null goes back to the key (A59). */
  updateSsh(id: string, input: { name?: string; directory?: string; hostKeys?: HostKeys; password?: string | null }): void {
    if (input.password !== undefined) this.db.prepare("UPDATE environments SET password=? WHERE id=? AND kind='ssh'")
      .run(input.password === null ? null : this.cipher.seal(input.password, `environment-password:${id}`), id);
    if (input.name !== undefined) this.db.prepare("UPDATE environments SET name=? WHERE id=? AND kind='ssh'").run(input.name, id);
    if (input.directory !== undefined) this.db.prepare("UPDATE environments SET directory=? WHERE id=? AND kind='ssh'").run(input.directory, id);
    if (input.hostKeys !== undefined) this.db.prepare("UPDATE environments SET host_keys=? WHERE id=? AND kind='ssh'").run(JSON.stringify(input.hostKeys), id);
  }
  /** The machine's private key (null when it doesn't open under this installation's key), its password when it is
   * reached with one (A59; `passwordUnreadable` when it is kept but doesn't open) and the accepted host keys. */
  sshSecrets(id: string): { privateKey: string | null; password: string | null; passwordUnreadable: boolean; hostKeys: HostKeys } | null {
    const row = this.db.prepare("SELECT key, password, host_keys AS hostKeys FROM environments WHERE id=? AND kind='ssh' AND deleted_at IS NULL")
      .get(id) as { key: string | null; password: string | null; hostKeys: string | null } | undefined;
    if (!row) return null;
    const password = row.password ? this.cipher.open(row.password, `environment-password:${id}`) : null;
    return { privateKey: row.key ? this.cipher.open(row.key, `environment:${id}`) : null, password, passwordUnreadable: !!row.password && password === null,
      hostKeys: row.hostKeys ? JSON.parse(row.hostKeys) as HostKeys : { keys: [], fingerprints: [] } };
  }
  /** Whether a machine is reached with its password rather than the key (A59). */
  usesPassword(id: string): boolean {
    return !!(this.db.prepare("SELECT password FROM environments WHERE id=? AND kind='ssh'").get(id) as { password: string | null } | undefined)?.password;
  }
  /** The Bots that may use an environment. */
  grantees(environmentId: string): string[] {
    return (this.db.prepare("SELECT g.bot_id AS botId FROM environment_grants g JOIN bots b ON b.id=g.bot_id WHERE g.environment_id=? AND b.deleted_at IS NULL ORDER BY g.granted_at")
      .all(environmentId) as { botId: string }[]).map(row => row.botId);
  }
  /** Deletes an SSH machine with its key: Bots working there are back in their default. Returns those Bots. */
  dropSsh(id: string): string[] {
    return transaction(this.db, () => {
      const moved = (this.db.prepare("SELECT id FROM bots WHERE current_environment_id=?").all(id) as { id: string }[]).map(row => row.id);
      this.db.prepare("UPDATE bots SET current_environment_id=home_environment_id WHERE current_environment_id=?").run(id);
      this.db.prepare("DELETE FROM environment_grants WHERE environment_id=?").run(id);
      this.db.prepare("UPDATE environments SET deleted_at=?, key=NULL, password=NULL WHERE id=? AND kind='ssh'").run(Date.now(), id);
      return moved;
    });
  }
}
