/** Public security hardening, TOTP 2FA, and audit log contracts (A112). */

export interface SecurityAuditEvent {
  id: number;
  at: number;
  kind: string;
  ip: string;
  detail: string;
}

export interface SecurityStatus {
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  activeSessions: number;
  tlsOnly: boolean;
  noWeb: boolean;
  localWebPort: number | null;
  trustProxy: boolean;
  recentEvents: SecurityAuditEvent[];
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
  issuer: string;
  account: string;
}

export interface TotpEnableResponse {
  enabled: true;
  recoveryCodes: string[];
}
