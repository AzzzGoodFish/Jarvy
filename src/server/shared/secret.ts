import type { Masker } from "./secret-mask.js";

/** Secrets (A52): the owner's tokens, passwords and keys. Values never leave the server except into a command that
 * uses them; people and Bots see names, descriptions and a keyed fingerprint. */
export type SecretKind = "value" | "ssh_key";
export type GrantScope = "always" | "once";
export interface SecretGrant { botId: string; scope: GrantScope; grantedAt: number }
export interface SecretRecord {
  id: string; name: string; kind: SecretKind;
  /** The Bot an SSH key belongs to. */
  botId: string | null;
  description: string; fingerprint: string; createdAt: number; updatedAt: number;
  /** False when the value does not open under this installation's master key; it must be entered again. */
  readable: boolean;
  grants: SecretGrant[];
  uses: number; lastUsedAt: number | null;
}
export interface SecretUse {
  id: number; secretName: string; botId: string; at: number; how: "command" | "ssh_sign";
  environmentId: string | null; historyId: number | null; toolCallId: string | null;
  /** What was run, with placeholders, never values. */
  detail: string;
}
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
