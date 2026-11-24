import { DatabaseIcon, GlobeIcon, KeyRoundIcon, LockIcon } from "lucide-react";
import { SECRET_CATEGORIES, type Secret, type SecretCategory, type SecretField } from "../../contract/secrets";
import { t, type Key } from "../i18n";

const CATEGORY_KEYS: Record<SecretCategory, Key> = {
  login: "secrets.cat.login",
  api_key: "secrets.cat.api_key",
  database: "secrets.cat.database",
  other: "secrets.cat.other",
};

const PRIMARY_VALUE_KEYS: Record<SecretCategory, Key> = {
  login: "secrets.primary.login",
  api_key: "secrets.primary.api_key",
  database: "secrets.primary.database",
  other: "secrets.primary.other",
};

export interface BuiltInFieldSpec {
  key: string;
  labelKey: Key;
  placeholderKey: Key;
}

const BUILTIN_FIELD_SPECS: Record<SecretCategory, readonly BuiltInFieldSpec[]> = {
  login: [
    { key: "url", labelKey: "secrets.field.url", placeholderKey: "secrets.placeholder.loginUrl" },
    { key: "username", labelKey: "secrets.field.username", placeholderKey: "secrets.placeholder.loginUsername" },
  ],
  api_key: [
    { key: "url", labelKey: "secrets.field.endpoint", placeholderKey: "secrets.placeholder.apiUrl" },
  ],
  database: [
    { key: "host", labelKey: "secrets.field.host", placeholderKey: "secrets.placeholder.dbHost" },
    { key: "port", labelKey: "secrets.field.port", placeholderKey: "secrets.placeholder.dbPort" },
    { key: "database", labelKey: "secrets.field.database", placeholderKey: "secrets.placeholder.dbName" },
    { key: "username", labelKey: "secrets.field.username", placeholderKey: "secrets.placeholder.dbUsername" },
  ],
  other: [],
};

const FIELD_LABEL_KEYS: Record<string, Key> = {
  url: "secrets.field.url",
  username: "secrets.field.username",
  host: "secrets.field.host",
  port: "secrets.field.port",
  database: "secrets.field.database",
};

export function builtInFieldsFor(category: SecretCategory): readonly BuiltInFieldSpec[] {
  return BUILTIN_FIELD_SPECS[category];
}

export function secretCategoryLabel(category: SecretCategory): string {
  return t(CATEGORY_KEYS[category]);
}

export function secretPrimaryLabel(category: SecretCategory): string {
  return t(PRIMARY_VALUE_KEYS[category]);
}

export function secretNamePlaceholder(category: SecretCategory): string {
  if (category === "login") return "STAGING_ADMIN";
  if (category === "database") return "PROD_PG";
  if (category === "api_key") return "GITHUB_TOKEN";
  return "SERVICE_SECRET";
}

export function fieldDisplayLabel(field: Pick<SecretField, "key" | "label">): string {
  if (field.label) return field.label;
  const builtin = FIELD_LABEL_KEYS[field.key.toLowerCase()];
  return builtin ? t(builtin) : field.key;
}

export function SecretCategoryIcon({ category, className }: { category: SecretCategory; className?: string }) {
  if (category === "login") return <GlobeIcon className={className} aria-hidden="true"/>;
  if (category === "api_key") return <KeyRoundIcon className={className} aria-hidden="true"/>;
  if (category === "database") return <DatabaseIcon className={className} aria-hidden="true"/>;
  return <LockIcon className={className} aria-hidden="true"/>;
}

/** Returns a safe http(s) href only when the saved URL is an explicit web URL (blocks javascript:/data:). */
export function safeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Short display label for an http(s) URL (host + optional non-root path) while keeping host:port addresses as written. */
export function compactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) return trimmed;
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";
    return `${parsed.host}${path}`;
  } catch {
    return trimmed;
  }
}

/** One-line summary combining public structured fields and description for rows and grant pickers. */
export function secretSummary(secret: Pick<Secret, "fields" | "description">): string {
  const byKey = new Map<string, string>();
  const extras: string[] = [];
  for (const field of secret.fields) {
    if (field.secret || !field.value) continue;
    const lower = field.key.toLowerCase();
    if (["url", "username", "host", "port", "database"].includes(lower)) byKey.set(lower, field.value);
    else extras.push(`${fieldDisplayLabel(field)}: ${field.value}`);
  }
  const host = byKey.get("host");
  const port = byKey.get("port");
  const endpoint = host ? `${host}${port ? `:${port}` : ""}` : byKey.get("url") ? compactUrl(byKey.get("url")!) : "";
  const parts = [
    byKey.get("username"),
    endpoint,
    byKey.get("database"),
    ...extras.slice(0, 1),
    secret.description,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Matches a search needle against name, description, and any field key/label/public value (never secret values). */
export function matchesSecretQuery(secret: Pick<Secret, "name" | "description" | "fields">, rawQuery: string): boolean {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return true;
  if (secret.name.toLowerCase().includes(needle) || secret.description.toLowerCase().includes(needle)) return true;
  return secret.fields.some(field =>
    field.key.toLowerCase().includes(needle)
    || (field.label ?? "").toLowerCase().includes(needle)
    || (!field.secret && (field.value ?? "").toLowerCase().includes(needle)),
  );
}

/** Segmented category selector used in Add/Edit secret forms and SecretRequestCard. */
export function SecretCategoryPicker({ value, onChange, disabled, compact }: {
  value: SecretCategory; onChange: (category: SecretCategory) => void; disabled?: boolean; compact?: boolean;
}) {
  return <div className="jv-secret-cats" role="radiogroup" aria-label={t("secrets.category")} data-compact={compact || undefined}>
    {SECRET_CATEGORIES.map(category => {
      const active = value === category;
      return <button key={category} type="button" role="radio" aria-checked={active} disabled={disabled}
        className="jv-secret-cat-btn" onClick={() => onChange(category)}>
        <SecretCategoryIcon category={category}/>
        <span>{secretCategoryLabel(category)}</span>
      </button>;
    })}
  </div>;
}
