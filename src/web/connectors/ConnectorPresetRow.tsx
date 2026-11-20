import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { api } from "../api";
import type { Connector, ConnectorOAuthState, ConnectorPreset } from "../../contract/connectors";
import { t } from "../i18n";
import { useAction } from "../action";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConnectorMark } from "./ConnectorMark";

type DrawerMode = "closed" | "oauth" | "token" | "env_guide";

/** One unconnected curated connector row (GitHub, Gmail, Linear) (A99):
 * stays a single calm row until clicked, and never creates a database record until sign-in or token check succeeds. */
export function ConnectorPresetRow({ preset, callbackUrl, onConnected }: {
  preset: ConnectorPreset; callbackUrl: string; onConnected: (connector: Connector) => void;
}) {
  const [mode, setMode] = useState<DrawerMode>("closed");
  const [oauth, setOAuth] = useState<ConnectorOAuthState | null>(null);
  const [token, setToken] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const flowIdRef = useRef<string | null>(null);
  const { busy, error, run, setError } = useAction();

  const canOAuth = preset.authMethods.includes("oauth");
  const canToken = preset.authMethods.includes("headers");
  const managed = preset.managedClient;
  const oauthReady = canOAuth && (!managed || managed.ready);

  const cancelFlow = () => {
    if (flowIdRef.current) {
      const id = flowIdRef.current;
      flowIdRef.current = null;
      void api.cancelPresetOAuth(id).catch(() => {});
    }
    setOAuth(null);
    setManualUrl("");
    setError("");
    setMode("closed");
  };

  useEffect(() => () => {
    if (flowIdRef.current) void api.cancelPresetOAuth(flowIdRef.current).catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== "oauth" || oauth?.phase !== "waiting" || !oauth.flowId) return;
    const flowId = oauth.flowId;
    const timer = window.setInterval(() => {
      void api.presetOAuthStatus(flowId).then(res => {
        setOAuth(res.oauth);
        if (res.oauth.phase === "completed" && res.connector) {
          flowIdRef.current = null;
          setMode("closed");
          setOAuth(null);
          onConnected(res.connector);
        } else if (res.oauth.phase === "error") {
          flowIdRef.current = null;
          setError(res.oauth.error || t("common.failed"));
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [mode, oauth?.phase, oauth?.flowId, onConnected, setError]);

  const startOAuth = () => void run("oauth", async () => {
    setError("");
    setMode("oauth");
    const state = await api.startPresetOAuth(preset.id, callbackUrl);
    setOAuth(state);
    flowIdRef.current = state.flowId ?? null;
    if (state.phase === "completed" && state.flowId) {
      const done = await api.presetOAuthStatus(state.flowId);
      flowIdRef.current = null;
      if (done.connector) { setMode("closed"); setOAuth(null); onConnected(done.connector); }
      return;
    }
    if (state.authUrl) window.open(state.authUrl, "_blank", "noopener,noreferrer");
  });

  const openConnect = () => {
    setError("");
    if (mode !== "closed") { cancelFlow(); return; }
    if (oauthReady) { startOAuth(); return; }
    if (canToken) { setMode("token"); return; }
    setMode("env_guide");
  };

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    void run("token", async () => {
      const created = await api.connectPresetToken(preset.id, token.trim());
      setToken("");
      setMode("closed");
      onConnected(created);
    });
  };

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    if (!manualUrl.trim() || !oauth?.flowId) return;
    const flowId = oauth.flowId;
    void run("manual", async () => {
      const res = await api.completePresetOAuth(flowId, { callbackUrl: manualUrl.trim() });
      setOAuth(res.oauth);
      if (res.oauth.phase === "completed" && res.connector) {
        flowIdRef.current = null;
        setManualUrl("");
        setMode("closed");
        setOAuth(null);
        onConnected(res.connector);
      }
    });
  };

  const copyCallback = () => {
    void navigator.clipboard?.writeText(callbackUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };

  const envVars = managed?.variables.join(" / ") ?? "";

  return <>
    <div className="jv-list-row jv-static-row jv-connector-preset-row">
      <span className="jv-connector-row">
        <ConnectorMark provider={preset.id} badge/>
        <span className="jv-row-text"><strong>{preset.name}</strong></span>
        <Button type="button" variant={mode === "closed" ? "outline" : "ghost"} size="sm" disabled={busy} onClick={openConnect}>
          {mode === "closed" ? t("connectors.connect") : t("common.cancel")}
        </Button>
      </span>
    </div>

    {mode === "oauth" && <div className="jv-connector-drawer">
      {(busy || oauth?.phase === "waiting") && <div className="jv-connector-waiting">
        <span className="jv-connector-waiting-dot" aria-hidden="true"/>
        <span>{t("connectors.oauthWaiting")}</span>
      </div>}
      <div className="jv-connector-drawer-foot">
        <div className="jv-connector-drawer-row">
          {oauth?.authUrl && <Button type="button" variant="outline" size="sm" onClick={() => window.open(oauth.authUrl, "_blank", "noopener,noreferrer")}>
            <ExternalLinkIcon/>{t("connectors.openBrowser")}
          </Button>}
          {!oauth && !busy && error && <Button type="button" variant="outline" size="sm" onClick={startOAuth}>
            {t("connectors.reconnect")}
          </Button>}
          {canToken && <button type="button" className="jv-connector-link-btn" onClick={() => { cancelFlow(); setMode("token"); }}>
            {t("connectors.useToken")}
          </button>}
        </div>
      </div>
      {oauth?.phase === "waiting" && <details className="jv-connector-manual">
        <summary>{t("connectors.manualFallback")}</summary>
        <form className="jv-connector-manual-row" onSubmit={submitManual}>
          <Input value={manualUrl} onChange={event => setManualUrl(event.target.value)} placeholder={t("connectors.manualPlaceholder")}/>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !manualUrl.trim()}>{t("connectors.manualSubmit")}</Button>
        </form>
      </details>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}

    {mode === "token" && <form className="jv-connector-drawer" onSubmit={submitToken}>
      <label className="jv-field">
        <span>{t("connectors.tokenLabel")}</span>
        <div className="jv-connector-drawer-row">
          <Input type="password" autoFocus value={token} onChange={event => setToken(event.target.value)} placeholder={t("connectors.tokenPlaceholder")}/>
          <Button type="submit" className="jv-primary" size="sm" disabled={busy || !token.trim()}>{t("connectors.connect")}</Button>
        </div>
      </label>
      <div className="jv-connector-drawer-foot">
        {oauthReady ? <button type="button" className="jv-connector-link-btn" onClick={startOAuth}>{t("connectors.useWebSignIn")}</button>
          : managed ? <p className="jv-connector-env-note">
              {t("connectors.envHint", { variables: envVars, callback: callbackUrl })}{" "}
              <button type="button" className="jv-connector-link-btn" onClick={copyCallback}>
                {copied ? t("connectors.copied") : t("connectors.copyCallback")}
              </button>
            </p> : <span/>}
      </div>
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </form>}

    {mode === "env_guide" && <div className="jv-connector-drawer">
      <p className="jv-connector-env-note">{t("connectors.gmailEnvHint", { variables: envVars, callback: callbackUrl })}</p>
      <div className="jv-connector-drawer-foot">
        <Button type="button" variant="outline" size="sm" onClick={copyCallback}>
          {copied ? <CheckIcon/> : <CopyIcon/>}
          {copied ? t("connectors.copied") : t("connectors.copyCallback")}
        </Button>
      </div>
    </div>}
  </>;
}
