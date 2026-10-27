import { useCallback, useState } from "react";
import { errorText } from "./errors";
import type { Key } from "./i18n";

/** A component's request in flight and what went wrong with the last one. `run(what, action, fallback)` clears the
 * error, marks `what` as running (`doing`; `busy` while anything runs), and on a failure words it with `errorText`
 * (`fallback` when the server didn't say). It resolves true when the action succeeded. Work that must happen only on
 * some failures (renewing an expired key) stays in `action`, which rethrows. */
export function useAction<K extends string = string>() {
  const [doing, setDoing] = useState<K | null>(null), [error, setError] = useState("");
  const run = useCallback(async (what: K, action: () => Promise<unknown>, fallback?: Key): Promise<boolean> => {
    setDoing(what); setError("");
    try { await action(); return true; }
    catch (reason) { setError(errorText(reason, fallback)); return false; }
    finally { setDoing(null); }
  }, []);
  return { busy: doing !== null, doing, error, setError, run };
}
