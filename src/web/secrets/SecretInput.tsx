import { EyeIcon, EyeOffIcon } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

/** A value field: masked by default, never filled in by the browser's password manager. A short value gets a warning:
 * Jarvy can't reliably hide it from what Bots see (A52). */
export function SecretInput({ value, visible, onChange, onVisible, placeholder, required, warnShort = true }: {
  value: string; visible: boolean; onChange: (value: string) => void; onVisible: (visible: boolean) => void; placeholder?: string; required?: boolean;
  /** Off for a value no Bot ever sees, such as a machine's password. */
  warnShort?: boolean;
}) {
  return <><span className="jv-secret-input">
    <Input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} required={required} className="jv-mono" placeholder={placeholder}
      value={value} onChange={event => onChange(event.target.value)}/>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => onVisible(!visible)}>
      {visible ? <EyeOffIcon/> : <EyeIcon/>}</Button>
  </span>{warnShort && value.length > 0 && value.length < 8 && <span className="jv-field-hint jv-secret-short">{t("secrets.shortValue")}</span>}</>;
}
