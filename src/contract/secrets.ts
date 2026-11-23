/** Secrets (A52): the owner's tokens, passwords and keys. Values never leave the server except into a command that
 * uses them; people and Bots see names, categories, non-secret associations (website/URL, username), descriptions
 * and a keyed fingerprint. */
export type SecretKind = "value" | "ssh_key";
export const SECRET_CATEGORIES = ["login", "api_key", "database", "other"] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];
export type GrantScope = "always" | "once";
export interface SecretGrant { botId: string; scope: GrantScope; grantedAt: number }
export interface Secret {
  id: string; name: string; kind: SecretKind;
  /** Semantic category for organization and Bot discovery (v36). */
  category: SecretCategory;
  /** Optional non-secret associated website URL or service address (v36). */
  url: string;
  /** Optional non-secret associated username, email or account identifier (v36). */
  username: string;
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
