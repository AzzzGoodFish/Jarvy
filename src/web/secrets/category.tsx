import { DatabaseIcon, GlobeIcon, KeyRoundIcon, LockIcon } from "lucide-react";
import { SECRET_CATEGORIES, type Secret, type SecretCategory } from "../../contract/secrets";
import { t, type Key } from "../i18n";

const CATEGORY_KEYS: Record<SecretCategory, Key> = {
  login: "secrets.cat.login",
  api_key: "secrets.cat.api_key",
  database: "secrets.cat.database",
  other: "secrets.cat.other",
};

export function secretCategoryLabel(category: SecretCategory): string {
  return t(CATEGORY_KEYS[category]);
}

export function SecretCategoryIcon({ category, className }: { category: SecretCategory; className?: string }) {
  if (category === "login") return <GlobeIcon className={className} aria-hidden="true"/>;
  if (category === "api_key") return <KeyRoundIcon className={className} aria-hidden="true"/>;
  if (category === "database") return <DatabaseIcon className={className} aria-hidden="true"/>;
  return <LockIcon className={className} aria-hidden="true"/>;
}

export function secretPlaceholders(category: SecretCategory): { name: string; url: string; username: string } {
  if (category === "login") {
    return { name: "STAGING_ADMIN_PASSWORD", url: t("secrets.urlPlaceholderLogin"), username: t("secrets.usernamePlaceholderLogin") };
  }
  if (category === "database") {
    return { name: "PROD_DB_PASSWORD", url: t("secrets.urlPlaceholderDatabase"), username: t("secrets.usernamePlaceholderDatabase") };
  }
  if (category === "api_key") {
    return { name: "GITHUB_TOKEN", url: t("secrets.urlPlaceholderApi"), username: t("secrets.usernamePlaceholderApi") };
  }
  return { name: "SERVICE_SECRET", url: t("secrets.urlPlaceholderOther"), username: t("secrets.usernamePlaceholderOther") };
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

/** One-line summary combining non-secret associations and description for rows and grant pickers. */
export function secretSummary(secret: Pick<Secret, "url" | "username" | "description">): string {
  const parts = [secret.username, compactUrl(secret.url), secret.description].filter(Boolean);
  return parts.join(" · ");
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
