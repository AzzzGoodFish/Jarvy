import type { DatabaseSync } from "node:sqlite";

/** A published port as stored (v30, A74); what a request finds there is the service's to learn. */
export interface PortRecord { botId: string; port: number; name: string; description: string; hostPort: number; createdAt: number; updatedAt: number }
type Row = { bot_id: string; port: number; name: string; description: string; host_port: number; created_at: number; updated_at: number };
const COLUMNS = "bot_id,port,name,description,host_port,created_at,updated_at";
const toRecord = (row: Row): PortRecord => ({ botId: row.bot_id, port: row.port, name: row.name, description: row.description,
  hostPort: row.host_port, createdAt: row.created_at, updatedAt: row.updated_at });

/** Ports Bots published from their sandboxes (A74). Rows of a deleted Bot go with it (BotRepository.delete). */
export class PortRepository {
  constructor(private readonly db: DatabaseSync) {}
  /** Every published port, of every Bot that still exists, by Jarvy's port. */
  all(): PortRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM published_ports p WHERE EXISTS(SELECT 1 FROM bots b WHERE b.id=p.bot_id AND b.deleted_at IS NULL)
      ORDER BY host_port`).all() as unknown as Row[]).map(toRecord);
  }
  /** A Bot's published ports, the first published first. */
  list(botId: string): PortRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM published_ports WHERE bot_id=? ORDER BY created_at, port`).all(botId) as unknown as Row[]).map(toRecord);
  }
  get(botId: string, port: number): PortRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM published_ports WHERE bot_id=? AND port=?`).get(botId, port) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }
  byHostPort(hostPort: number): PortRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM published_ports WHERE host_port=?`).get(hostPort) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }
  /** Jarvy's ports already taken, for picking a free one. */
  hostPorts(): Set<number> {
    return new Set((this.db.prepare("SELECT host_port FROM published_ports").all() as { host_port: number }[]).map(row => row.host_port));
  }
  /** Publishes a port on `hostPort`, or renames one already published, which keeps its own Jarvy port. */
  save(input: { botId: string; port: number; name: string; description: string; hostPort: number }): PortRecord {
    const now = Date.now();
    this.db.prepare(`INSERT INTO published_ports(${COLUMNS}) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(bot_id, port) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`)
      .run(input.botId, input.port, input.name, input.description, input.hostPort, now, now);
    return this.get(input.botId, input.port)!;
  }
  /** Moves a published port to another Jarvy port, when its own was taken by another program meanwhile. */
  move(botId: string, port: number, hostPort: number): void {
    this.db.prepare("UPDATE published_ports SET host_port=?, updated_at=? WHERE bot_id=? AND port=?").run(hostPort, Date.now(), botId, port);
  }
  remove(botId: string, port: number): boolean {
    return Number(this.db.prepare("DELETE FROM published_ports WHERE bot_id=? AND port=?").run(botId, port).changes) > 0;
  }
  /** Unpublishes all of a Bot's ports, as when its sandbox is reset. */
  removeAll(botId: string): number {
    return Number(this.db.prepare("DELETE FROM published_ports WHERE bot_id=?").run(botId).changes);
  }
}
