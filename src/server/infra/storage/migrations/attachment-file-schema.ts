import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { attachmentPath } from "../../files/attachments.js";
import { migration, userVersion } from "../transaction.js";

/** v28 (A66): attachment contents leave the database for files under `<data>/attachments`. Each row's bytes are
 * written out first (to a temporary name, flushed, then renamed, so a stop halfway leaves no half file); a file
 * already there with the right size is kept, so running again after a stop picks up where it left off. Only when
 * every row has its file does the transaction drop the column. A table of removed ids, filled by a trigger, tells the
 * program which files to delete after any delete of attachments, cascades included. The database is compacted
 * afterwards to give the space back. Downgrading needs a v27 backup and matching program. */
export function migrateAttachmentFiles(db: DatabaseSync, dataDir: string): void {
  if (userVersion(db) >= 28) return;
  const root = join(dataDir, "attachments");
  const rows = db.prepare("SELECT id,size,data FROM attachments").iterate() as Iterable<{ id: string; size: number; data: Uint8Array }>;
  for (const row of rows) writeOut(attachmentPath(root, row.id), row.data);
  migration(db, 28, () => {
    for (const { id, size } of db.prepare("SELECT id,size FROM attachments").all() as { id: string; size: number }[]) {
      if (sizeOf(attachmentPath(root, id)) !== size) throw new Error(`Attachment ${id} was not written out`);
    }
    db.exec(`ALTER TABLE attachments DROP COLUMN data;
      CREATE TABLE attachment_removals(id TEXT PRIMARY KEY);
      CREATE TRIGGER attachment_removed AFTER DELETE ON attachments BEGIN INSERT OR IGNORE INTO attachment_removals(id) VALUES(old.id); END;`);
  });
  db.exec("VACUUM");
}

function writeOut(path: string, data: Uint8Array): void {
  if (sizeOf(path) === data.length) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.migrating`, fd = openSync(temp, "w", 0o600);
  try {
    for (let written = 0; written < data.length;) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
}
function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}
