import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Bot } from "../../shared/models.js";
import { BOT_COLORS, type BotColor } from "../../../contract/models.js";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import type { ModelSelection } from "../../shared/runtime.js";
import { THINKING_LEVELS, type ModelConnectionRepository } from "./model-connection-repository.js";
import type { InboxRepository } from "./inbox-repository.js";
import { optionalText, requireText } from "./text.js";
import { transaction } from "./transaction.js";

/** The owner's Bots: name, description, persona, color and model; each has a workspace folder under the data
 * directory. A deleted Bot keeps its row and member identity (see delete). */
export class BotRepository {
  /** `inbox`: a deleted Bot's deliveries go with it (A61). */
  constructor(private readonly db: DatabaseSync, private readonly dataDir: string, private readonly ownerId: () => string, private readonly connections: ModelConnectionRepository,
    private readonly inbox: InboxRepository) {}

  private fromRow(row: Omit<Bot, "workspacePath">): Bot {
    const workspacePath = join(this.dataDir, "bots", row.id, "workspace");
    mkdirSync(join(workspacePath, "temp"), { recursive: true, mode: 0o700 });
    return { ...row, workspacePath };
  }
  list(): Bot[] {
    const rows = this.db.prepare("SELECT id,name,description,system_prompt AS systemPrompt,connection_id AS connectionId,model_id AS modelId,thinking_level AS thinkingLevel,color,mood,created_at AS createdAt FROM bots WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at,id")
      .all(this.ownerId()) as unknown as Omit<Bot, "workspacePath">[];
    return rows.map(row => this.fromRow(row));
  }
  get(id: string): Bot | null {
    const row = this.db.prepare("SELECT id,name,description,system_prompt AS systemPrompt,connection_id AS connectionId,model_id AS modelId,thinking_level AS thinkingLevel,color,mood,created_at AS createdAt FROM bots WHERE id=? AND owner_id=? AND deleted_at IS NULL")
      .get(id, this.ownerId()) as Omit<Bot, "workspacePath"> | undefined;
    return row ? this.fromRow(row) : null;
  }
  /** Member names are unique across people and Bots, ignoring case, so "@name" in a message is unambiguous (A37). */
  private nameTaken(name: string, exceptBotId?: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM account WHERE lower(username)=lower(:name)
      UNION ALL SELECT 1 FROM bots WHERE lower(name)=lower(:name) AND id<>:except AND deleted_at IS NULL LIMIT 1`).get({ name, except: exceptBotId ?? "" });
  }
  /** Deletes a Bot: its DMs (with anyone), channel memberships and states, queued deliveries,
   * notices and session row go; the member row stays, marked deleted, so messages it left in channels keep their
   * author, and its name is free again. Files are the caller's (BotService). */
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    transaction(this.db, () => {
      // A deleted Bot uses no connection, so the owner can delete the one it had.
      this.db.prepare("UPDATE bots SET deleted_at=?, connection_id=NULL WHERE id=?").run(Date.now(), id);
      this.db.prepare("DELETE FROM chats WHERE type='dm' AND id IN (SELECT chat_id FROM chat_members WHERE member_id=?)").run(id);
      for (const table of ["chat_members", "chat_states"]) this.db.prepare(`DELETE FROM ${table} WHERE member_id=?`).run(id);
      this.inbox.forget(id);
      this.db.prepare("DELETE FROM bot_sessions WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM environment_grants WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM secret_grants WHERE bot_id=?").run(id);
    });
    return true;
  }
  private botName(value: unknown, exceptBotId?: string): string {
    const name = requireText(value, "Bot name", 80);
    if (name.includes("@") || /[\n\r]/.test(name)) throw new ValidationError("Bot name cannot contain @ or line breaks");
    if (this.nameTaken(name, exceptBotId)) throw new ConflictError("Another member already has this name", "name_taken");
    return name;
  }
  /** The caller names the Bot (A45: the interface picks a free default in its own language). */
  create(name: unknown): Bot {
    const clean = this.botName(name);
    const id = randomUUID(), createdAt = Date.now();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO members VALUES(?,'bot')").run(id);
      this.db.prepare("INSERT INTO bots(id,name,description,system_prompt,model_id,created_at,owner_id,thinking_level,color) VALUES(?,?,?,?,?,?,?,'auto',?)")
        .run(id, clean, "", "", "", createdAt, this.ownerId(), BOT_COLORS[randomInt(BOT_COLORS.length)]!);
    });
    return this.get(id)!;
  }
  update(id: string, input: Record<string, unknown>): Bot | null {
    if (!this.get(id)) return null;
    const name = this.botName(input.name, id);
    const description = optionalText(input.description, "Description", 1000);
    const systemPrompt = optionalText(input.systemPrompt, "Persona", 16_000);
    if (!this.db.prepare("UPDATE bots SET name=?,description=?,system_prompt=? WHERE id=?")
      .run(name, description, systemPrompt, id).changes) return null;
    return this.get(id);
  }
  validateSelection(id: string, input: Record<string, unknown>): ModelSelection | null {
    const bot = this.get(id);
    if (!bot) return null;
    const connectionId = requireText(input.connectionId, "Connection ID", 80);
    const modelId = requireText(input.modelId, "Model ID", 200);
    const thinkingLevel = input.thinkingLevel === undefined ? bot.thinkingLevel : requireText(input.thinkingLevel, "Thinking level", 24);
    if (thinkingLevel !== "auto" && !THINKING_LEVELS.has(thinkingLevel)) throw new ValidationError("Invalid thinking level");
    if (!this.connections.get(connectionId) || !this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(connectionId, modelId))
      throw new ConflictError("Model not found in this connection");
    return { connectionId, modelId, thinkingLevel };
  }
  setColor(id: string, color: unknown): Bot | null {
    if (!BOT_COLORS.includes(color as BotColor)) throw new ValidationError("Invalid Bot color");
    if (!this.get(id)) return null;
    this.db.prepare("UPDATE bots SET color=? WHERE id=?").run(color as string, id);
    return this.get(id);
  }
}
