import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CopyIcon, LogOutIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import type { SecurityStatus, TotpSetupResponse } from "../contract/security";
import { api } from "./api";
import { errorText } from "./errors";
import { t } from "./i18n";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./styles/environment.css";
import "./styles/security.css";

/** Settings → Security (A112): TOTP 2FA setup/management, active session revocation, runtime transport flags, and security audit log. */
export function SecuritySettings() {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "enable" | "disable" | "regen">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.securityStatus());
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const resetForm = () => { setMode("idle"); setSetup(null); setPassword(""); setCode(""); setError(null); };

  const startEnable = async () => {
    setBusy(true); setError(null); setNotice(null); setRecoveryCodes(null);
    try {
      setSetup(await api.beginTotpSetup());
      setMode("enable");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const submitEnable = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await api.enableTotp(password, code.trim());
      setRecoveryCodes(res.recoveryCodes);
      resetForm();
      setNotice(t("security.totpEnabledNotice"));
      await load();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const submitDisableOrRegen = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "disable") {
        await api.disableTotp(password, code.trim());
        setRecoveryCodes(null);
        setNotice(t("security.totpDisabledNotice"));
      } else if (mode === "regen") {
        const res = await api.regenerateRecoveryCodes(password, code.trim());
        setRecoveryCodes(res.recoveryCodes);
        setNotice(t("security.recoveryRotatedNotice"));
      }
      resetForm();
      await load();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const revokeOthers = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await api.revokeOtherSessions();
      setNotice(t("security.sessionsRevoked", { count: res.revoked }));
      await load();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const copyText = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => setNotice(t("security.copied"))).catch(() => {});
  };

  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.security")}</h2></header>

    <section className="jv-section" aria-labelledby="security-2fa">
      <h3 id="security-2fa" className="jv-section-title">{t("security.totpSection")}</h3>
      <div className="jv-list jv-env-sandbox">
        <div className="jv-list-row jv-static-row">
          <span className="jv-row-text">
            <strong>{t("security.totpTitle")}</strong>
            <span>{t("security.totpHint")}</span>
          </span>
          <span className="jv-status" data-ok={status?.totpEnabled || undefined}>
            {t(status?.totpEnabled ? "security.enabled" : "security.disabled")}
          </span>
        </div>

        {status?.totpEnabled && <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.recoveryRemaining")}</span>
          <code>{status.recoveryCodesRemaining}</code>
        </div>}

        {mode === "idle" && status && <div className="jv-list-row jv-static-row jv-env-details">
          <div className="jv-sec-actions">
            {!status.totpEnabled ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void startEnable()}>
                <ShieldCheckIcon aria-hidden="true"/>{t("security.enableTotp")}
              </Button>
            ) : <>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setMode("regen"); setError(null); setNotice(null); }}>
                {t("security.regenerateRecovery")}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setMode("disable"); setError(null); setNotice(null); }}>
                {t("security.disableTotp")}
              </Button>
            </>}
          </div>
        </div>}

        {mode === "enable" && setup && <div className="jv-list-row jv-static-row jv-env-details">
          <p className="jv-hint">{t("security.scanHint")}</p>
          <div className="jv-sec-qr-wrap">
            <img className="jv-sec-qr" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt={t("security.qrAlt")} width={176} height={176}/>
            <div className="jv-sec-setup-meta">
              <span className="jv-hint">{t("security.manualKey")}</span>
              <code className="jv-sec-secret">{setup.secret}</code>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(setup.secret)}>
                  <CopyIcon aria-hidden="true"/>{t("security.copyKey")}
                </Button>
              </div>
            </div>
          </div>
          <form className="jv-sec-form" onSubmit={e => void submitEnable(e)}>
            <label className="jv-field"><span>{t("security.currentPassword")}</span>
              <Input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>
            <label className="jv-field"><span>{t("security.verifyCode")}</span>
              <Input required value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456"/></label>
            <div className="jv-sec-actions">
              <Button type="submit" size="sm" disabled={busy}>{t("security.confirmEnable")}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={resetForm}>{t("security.cancel")}</Button>
            </div>
          </form>
        </div>}

        {(mode === "disable" || mode === "regen") && <div className="jv-list-row jv-static-row jv-env-details">
          <form className="jv-sec-form" onSubmit={e => void submitDisableOrRegen(e)}>
            <label className="jv-field"><span>{t("security.currentPassword")}</span>
              <Input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>
            <label className="jv-field"><span>{t("security.totpOrRecovery")}</span>
              <Input required value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456"/></label>
            <div className="jv-sec-actions">
              <Button type="submit" size="sm" disabled={busy}>{t(mode === "disable" ? "security.confirmDisable" : "security.confirmRegenerate")}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={resetForm}>{t("security.cancel")}</Button>
            </div>
          </form>
        </div>}

        {recoveryCodes && <div className="jv-list-row jv-static-row jv-env-details">
          <p className="jv-hint">{t("security.recoverySaveHint")}</p>
          <div className="jv-sec-recovery-grid">
            {recoveryCodes.map(rc => <code key={rc}>{rc}</code>)}
          </div>
          <div className="jv-sec-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => copyText(recoveryCodes.join("\n"))}>
              <CopyIcon aria-hidden="true"/>{t("security.copyRecovery")}
            </Button>
          </div>
        </div>}
      </div>
    </section>

    <section className="jv-section" aria-labelledby="security-runtime">
      <h3 id="security-runtime" className="jv-section-title">{t("security.runtimeSection")}</h3>
      {status && <div className="jv-list jv-env-sandbox">
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.activeSessions")}</span>
          <code>{status.activeSessions}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.tlsOnly")}</span>
          <code>{t(status.tlsOnly ? "security.enabled" : "security.disabled")}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.noWeb")}</span>
          <code>{t(status.noWeb ? "security.enabled" : "security.disabled")}</code>
        </div>
        {status.localWebPort !== null && <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.localWebPort")}</span>
          <code>127.0.0.1:{status.localWebPort}</code>
        </div>}
        <div className="jv-list-row jv-static-row jv-env-fact">
          <span>{t("security.trustProxy")}</span>
          <code>{t(status.trustProxy ? "security.enabled" : "security.disabled")}</code>
        </div>
        <div className="jv-list-row jv-static-row jv-env-details">
          <div className="jv-sec-actions">
            <Button type="button" variant="outline" size="sm" disabled={busy || status.activeSessions <= 1} onClick={() => void revokeOthers()}>
              <LogOutIcon aria-hidden="true"/>{t("security.revokeOthers")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
              <RefreshCwIcon aria-hidden="true"/>{t("security.refresh")}
            </Button>
          </div>
        </div>
      </div>}
      {notice && <p className="jv-hint" role="status">{notice}</p>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </section>

    <section className="jv-section" aria-labelledby="security-audit">
      <h3 id="security-audit" className="jv-section-title">{t("security.auditSection")}</h3>
      <div className="jv-list">
        {status && status.recentEvents.length === 0 && <div className="jv-list-row jv-static-row">
          <span className="jv-hint">{t("security.auditEmpty")}</span>
        </div>}
        {status?.recentEvents.map(ev => <div key={ev.id} className="jv-list-row jv-static-row jv-sec-event-row">
          <span>
            <span className="jv-sec-event-kind">{ev.kind}</span>
            {ev.detail ? <span className="jv-sec-event-meta"> · {ev.detail}</span> : null}
          </span>
          <span className="jv-sec-event-meta">{ev.ip} · {new Date(ev.at).toLocaleString()}</span>
        </div>)}
      </div>
    </section>
  </div>;
}
