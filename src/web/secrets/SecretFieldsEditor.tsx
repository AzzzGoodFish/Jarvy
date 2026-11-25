import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import type { SecretCategory, SecretField, SecretFieldInput } from "../../contract/secrets";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SecretInput } from "./SecretInput";
import { builtInFieldsFor } from "./category";

export interface CustomFieldDraft {
  id: string;
  key: string;
  label?: string;
  secret: boolean;
  value: string;
  visible?: boolean;
  /** True when editing an already-saved secret field whose sealed value can be kept by leaving value blank. */
  savedSecret?: boolean;
  fingerprint?: string;
}

export interface SecretFieldsDraft {
  builtIn: Record<string, string>;
  custom: CustomFieldDraft[];
}

const MAX_FIELDS = 16;
let nextDraftId = 1;
const uid = () => `sf-${nextDraftId++}`;

/** Splits stored or hinted fields into built-in template values and custom extensible field drafts. */
export function toFieldsDraft(
  category: SecretCategory,
  fields: readonly (SecretField | SecretFieldInput)[] | undefined,
  savedMode: boolean,
): SecretFieldsDraft {
  const builtInKeys = new Set(builtInFieldsFor(category).map(spec => spec.key));
  const builtIn: Record<string, string> = {};
  const custom: CustomFieldDraft[] = [];
  for (const field of fields ?? []) {
    if (!field.secret && builtInKeys.has(field.key)) {
      builtIn[field.key] = field.value ?? "";
    } else {
      const saved = savedMode && field.secret;
      custom.push({
        id: uid(),
        key: field.key,
        ...(field.label ? { label: field.label } : {}),
        secret: field.secret,
        value: field.secret ? "" : (field.value ?? ""),
        savedSecret: saved,
        ...("fingerprint" in field && field.fingerprint ? { fingerprint: field.fingerprint } : {}),
      });
    }
  }
  return { builtIn, custom };
}

/** Moves fields cleanly between built-in and custom buckets when the user switches category template. */
export function remapDraftCategory(prevCategory: SecretCategory, nextCategory: SecretCategory, draft: SecretFieldsDraft): SecretFieldsDraft {
  const nextKeys = new Set(builtInFieldsFor(nextCategory).map(spec => spec.key));
  const builtIn: Record<string, string> = {};
  const custom: CustomFieldDraft[] = [];

  for (const spec of builtInFieldsFor(prevCategory)) {
    const val = draft.builtIn[spec.key] ?? "";
    if (!val) continue;
    if (nextKeys.has(spec.key)) builtIn[spec.key] = val;
    else custom.push({ id: uid(), key: spec.key, secret: false, value: val });
  }
  for (const field of draft.custom) {
    if (!field.secret && nextKeys.has(field.key) && builtIn[field.key] === undefined) {
      builtIn[field.key] = field.value;
    } else {
      custom.push(field);
    }
  }
  return { builtIn, custom };
}

/** Serializes draft fields into API `SecretFieldInput[]`, omitting empty optional public fields. */
export function serializeFieldsDraft(category: SecretCategory, draft: SecretFieldsDraft): SecretFieldInput[] {
  const out: SecretFieldInput[] = [];
  for (const spec of builtInFieldsFor(category)) {
    const val = (draft.builtIn[spec.key] ?? "").trim();
    if (val) out.push({ key: spec.key, secret: false, value: val });
  }
  for (const field of draft.custom) {
    const key = field.key.trim();
    if (!key) continue;
    if (field.secret) {
      out.push({
        key,
        ...(field.label ? { label: field.label } : {}),
        secret: true,
        ...(field.value ? { value: field.value } : {}),
      });
    } else {
      const val = field.value.trim();
      if (val) out.push({ key, ...(field.label ? { label: field.label } : {}), secret: false, value: val });
    }
  }
  return out;
}

/** Returns true when every custom field with a key (especially new `secret: true` fields) is ready to submit. */
export function fieldsDraftReady(draft: SecretFieldsDraft): boolean {
  for (const field of draft.custom) {
    const key = field.key.trim();
    if (!key) {
      if (field.value.trim()) return false;
      continue;
    }
    if (field.secret && !field.savedSecret && !field.value) return false;
  }
  return true;
}

/** Shared template + extensible custom fields editor (with per-field secret toggle) used in Settings and SecretRequestCard. */
export function SecretFieldsEditor({ category, draft, onChange, disabled, compact }: {
  category: SecretCategory;
  draft: SecretFieldsDraft;
  onChange: (next: SecretFieldsDraft) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const builtInSpecs = builtInFieldsFor(category);
  const usedCount = builtInSpecs.filter(s => (draft.builtIn[s.key] ?? "").trim()).length + draft.custom.length;
  const canAdd = usedCount < MAX_FIELDS;

  const setBuiltIn = (key: string, value: string) => {
    onChange({ ...draft, builtIn: { ...draft.builtIn, [key]: value } });
  };

  const updateCustom = (id: string, patch: Partial<CustomFieldDraft>) => {
    onChange({ ...draft, custom: draft.custom.map(item => item.id === id ? { ...item, ...patch } : item) });
  };

  const removeCustom = (id: string) => {
    onChange({ ...draft, custom: draft.custom.filter(item => item.id !== id) });
  };

  const addCustom = () => {
    if (!canAdd) return;
    onChange({ ...draft, custom: [...draft.custom, { id: uid(), key: "", secret: false, value: "" }] });
  };

  return <div className="jv-secret-fields-editor" data-compact={compact || undefined}>
    {builtInSpecs.length > 0 && <div className="jv-secret-pair">
      {builtInSpecs.map(spec => <label key={spec.key} className="jv-field">
        <span>{t(spec.labelKey)}</span>
        <Input maxLength={500} disabled={disabled} placeholder={t(spec.placeholderKey)}
          value={draft.builtIn[spec.key] ?? ""} onChange={event => setBuiltIn(spec.key, event.target.value)}/>
      </label>)}
    </div>}

    <div className="jv-secret-custom-section">
      <div className="jv-secret-custom-head">
        <span className="jv-secret-custom-title">{t("secrets.customFields")}</span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || !canAdd} onClick={addCustom}>
          <PlusIcon/>{t("secrets.addField")}
        </Button>
      </div>
      {draft.custom.length > 0 && <div className="jv-secret-custom-list">
        {draft.custom.map(field => <div key={field.id} className="jv-secret-custom-row">
          <Input className="jv-mono jv-secret-custom-key" maxLength={64} disabled={disabled || field.savedSecret}
            placeholder={t("secrets.fieldKeyPlaceholder")} aria-label={t("secrets.fieldKey")}
            value={field.key} onChange={event => updateCustom(field.id, { key: event.target.value })}/>
          <button type="button" className="jv-secret-toggle-btn" disabled={disabled}
            aria-pressed={field.secret} title={t(field.secret ? "secrets.fieldSecretHint" : "secrets.fieldPublicHint")}
            onClick={() => updateCustom(field.id, { secret: !field.secret, savedSecret: false, value: "" })}>
            {field.secret ? <LockIcon aria-hidden="true"/> : <LockOpenIcon aria-hidden="true"/>}
            <span>{t(field.secret ? "secrets.fieldSecret" : "secrets.fieldPublic")}</span>
          </button>
          <div className="jv-secret-custom-val">
            {field.secret
              ? <SecretInput value={field.value} visible={Boolean(field.visible)}
                  placeholder={field.savedSecret ? t("secrets.newValuePlaceholder") : t("secrets.fieldSecretValuePlaceholder")}
                  onChange={val => updateCustom(field.id, { value: val })}
                  onVisible={vis => updateCustom(field.id, { visible: vis })}/>
              : <Input maxLength={500} disabled={disabled} placeholder={t("secrets.fieldValuePlaceholder")}
                  value={field.value} onChange={event => updateCustom(field.id, { value: event.target.value })}/>}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled}
            aria-label={t("secrets.removeField")} onClick={() => removeCustom(field.id)}>
            <XIcon/>
          </Button>
        </div>)}
      </div>}
    </div>
  </div>;
}
