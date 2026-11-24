/** Secrets (A52): the owner's tokens, passwords and keys. Values never leave the server except into a command that
 * uses them; people and Bots see names, categories, non-secret fields, secret field placeholders and keyed fingerprints. */
export type SecretKind = "value" | "ssh_key";
export const SECRET_CATEGORIES = ["login", "api_key", "database", "other"] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];
export type GrantScope = "always" | "once";
export interface SecretGrant { botId: string; scope: GrantScope; grantedAt: number }

/** One structured field attached to a secret (v36): either public metadata (`secret: false`) or an encrypted secret
 * field (`secret: true`, sealed under AES-256-GCM, masked, usable in bash via `{{secret:NAME.FIELD}}`). */
export interface SecretField {
  key: string;
  label?: string;
  secret: boolean;
  /** Plaintext value when `secret === false`. Omitted for `secret === true`. */
  value?: string;
  /** 8-hex-digit HMAC fingerprint when `secret === true`. */
  fingerprint?: string;
  /** False when a sealed field value does not open under this installation's master key. */
  readable?: boolean;
}

/** Input payload for creating/updating structured fields. Omitting `value` (or empty string) on an existing
 * `secret: true` field preserves its currently stored encrypted value. */
export interface SecretFieldInput {
  key: string;
  label?: string;
  secret: boolean;
  value?: string;
}

export interface Secret {
  id: string; name: string; kind: SecretKind;
  /** Semantic category/template for organization, typed fields and Bot discovery (v36). */
  category: SecretCategory;
  /** Structured built-in and custom fields (v36); secret fields never include plaintext values. */
  fields: SecretField[];
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
