/** Secrets (A52): values never leave the server except into a command that uses them. */
import type { Masker } from "./secret-mask.js";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** What a Bot's run may do with secrets (A52): the session's side of it, kept apart from storage. */
export interface SecretAccess {
  /** The values of the named secrets, when the Bot may use every one of them; else the names it may not use. */
  resolve(names: readonly string[]): { values: Record<string, string> } | { refused: string[] };
  /** One command used these secrets. */
  record(names: readonly string[], use: { environmentId: string | null; toolCallId: string | null; detail: string }): void;
  /** The masker for every value the owner keeps, current as of this call. */
  masker(): Masker;
}
