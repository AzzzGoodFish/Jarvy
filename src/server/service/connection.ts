import type { Store } from "../infra/storage/store.js";
import { certificates, isLoopbackHost, lanAddresses, type TlsMaterial } from "../infra/tls/certificates.js";

/** How Jarvy is reached (A51). Listening only on this machine it serves plain HTTP, as browsers count `localhost` as
 * secure. Listening beyond it, it serves HTTPS with its own certificates on the same port, and plain HTTP from other
 * machines is redirected unless the owner allows it in Settings. */
export interface ConnectionInfo {
  /** Whether Jarvy listens beyond this machine and so serves HTTPS. */
  https: boolean;
  allowHttp: boolean;
  /** HTTPS addresses other devices may use. */
  addresses: string[];
  /** The root certificate's SHA-256, colon-separated hex; null without HTTPS. */
  fingerprint: string | null;
  /** Its SHA-1, as Windows' certificate window shows it; null without HTTPS. */
  fingerprintSha1: string | null;
}
const ALLOW_HTTP = "allow_http";

export class ConnectionService {
  private material: TlsMaterial | null = null;
  private listening: { host: string; port: number } | null = null;
  constructor(private readonly store: Store, private readonly dataDir: string) {}

  /** Called once before listening: the certificate to serve, or null when Jarvy stays on this machine. */
  prepare(host: string, port: number): TlsMaterial | null {
    this.listening = { host, port };
    this.material = isLoopbackHost(host) ? null : certificates(this.dataDir, host, this.store.cipher);
    return this.material;
  }
  allowHttp(): boolean { return this.store.settings.get(ALLOW_HTTP) === "1"; }
  setAllowHttp(allow: boolean): ConnectionInfo { this.store.settings.set(ALLOW_HTTP, allow ? "1" : null); return this.info(); }
  info(): ConnectionInfo {
    const listening = this.listening, material = this.material;
    const addresses = listening && material ? lanAddresses(listening.host).map(address => `https://${address.includes(":") ? `[${address}]` : address}:${listening.port}`) : [];
    return { https: !!material, allowHttp: this.allowHttp(), addresses, fingerprint: material?.fingerprint ?? null, fingerprintSha1: material?.fingerprintSha1 ?? null };
  }
  /** The root certificate (DER) for devices to install, when serving HTTPS. */
  rootCertificate(): Buffer | null { return this.material?.rootDer ?? null; }
}
