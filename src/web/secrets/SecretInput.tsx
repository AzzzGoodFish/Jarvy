import { EyeIcon, EyeOffIcon } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

/** A value field: masked by default, never filled in by the browser's password manager. */
export function SecretInput({ value, visible, onChange, onVisible, placeholder, required }: {
  value: string; visible: boolean; onChange: (value: string) => void; onVisible: (visible: boolean) => void; placeholder?: string; required?: boolean;
}) {
  return <span className="jv-secret-input">
    <Input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} required={required} className="jv-mono" placeholder={placeholder}
      value={value} onChange={event => onChange(event.target.value)}/>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => onVisible(!visible)}>
      {visible ? <EyeOffIcon/> : <EyeIcon/>}</Button>
  </span>;
}
