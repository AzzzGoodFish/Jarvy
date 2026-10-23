import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { errorText } from "../errors";
import { copyText } from "../ui";

/** How the owner lets Jarvy in (A59): the password, which installs Jarvy's key, or adding Jarvy's public key to the
 * machine themselves. */
export type MachineLogin = "password" | "key";

/** Jarvy's public key for a machine, one line to add to its authorized_keys, with a copy button. */
export function MachineKeyLine({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <div className="jv-machine-key">
    <code>{publicKey}</code>
    <button type="button" className="ui-button jv-machine-copy" aria-label={t("machines.copy")} onClick={() => void copyText(publicKey).then(setCopied)}>
      {copied ? <CheckIcon aria-hidden="true"/> : <CopyIcon aria-hidden="true"/>}<span>{t(copied ? "machines.copied" : "machines.copy")}</span></button>
  </div>;
}

/** A key made for a machine not added yet, fetched once the owner picks「我自己加公钥」 and kept while the form is open. */
export function usePreparedKey(wanted: boolean) {
  const [key, setKey] = useState<{ keyId: string; publicKey: string } | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || key) return;
    let alive = true;
    void api.prepareMachineKey().then(made => { if (alive) setKey(made); }).catch(reason => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; };
  }, [wanted, key]);
  return { key, error, renew: () => { setKey(null); setError(null); } };
}
