import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AGENT_BOT_ID, BOT_COLORS } from "../../shared/models.js";
import { transaction } from "./transaction.js";

/** The agent Bot's storage (v19, A48): the setup Bot kept in place and the onboarding mark. */
export class AgentRepository {
  constructor(private readonly db: DatabaseSync, private readonly ownerId: () => string) {}
  /** Brings the agent Bot back when it is missing (deleted before it became undeletable): the same id, the first free
   * name of Jarvy, Jarvy 2, …, no persona and no model, so the owner picks one and is welcomed again. */
  ensure(): void {
    const row = this.db.prepare("SELECT deleted_at AS deletedAt FROM bots WHERE id=?").get(AGENT_BOT_ID) as { deletedAt: number | null } | undefined;
    if (row && row.deletedAt === null) return;
    const taken = this.db.prepare(`SELECT 1 FROM account WHERE lower(username)=lower(:name)
      UNION ALL SELECT 1 FROM bots WHERE lower(name)=lower(:name) AND deleted_at IS NULL LIMIT 1`);
    let name = "Jarvy";
    for (let n = 2; taken.get({ name }); n++) name = `Jarvy ${n}`;
    transaction(this.db, () => {
      if (row) this.db.prepare(`UPDATE bots SET deleted_at=NULL,name=?,description='',system_prompt='',connection_id=NULL,model_id='',thinking_level='auto'
        WHERE id=?`).run(name, AGENT_BOT_ID);
      else {
        this.db.prepare("INSERT OR IGNORE INTO members VALUES(?,'bot')").run(AGENT_BOT_ID);
        this.db.prepare("INSERT INTO bots(id,name,description,system_prompt,model_id,created_at,owner_id,thinking_level,color) VALUES(?,?,'','','',?,?,'auto',?)")
          .run(AGENT_BOT_ID, name, Date.now(), this.ownerId(), BOT_COLORS[randomInt(BOT_COLORS.length)]!);
      }
      this.db.prepare("DELETE FROM settings WHERE key='agent_onboarded'").run();
    });
  }
  /** Records that the owner is being welcomed; false when that already happened, so only one caller asks. */
  markOnboarded(): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('agent_onboarded',?)").run(String(Date.now())).changes) > 0;
  }
}
