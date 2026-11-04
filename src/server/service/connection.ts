import type { Store } from "../infra/storage/store.js";
import type { ConnectionInfo } from "../../contract/connection.js";
import type { PortRange } from "../../contract/ports.js";
import { certificates, isLoopbackHost, lanAddresses, type TlsMaterial } from "../infra/tls/certificates.js";
import { ValidationError } from "../shared/errors.js";

const ALLOW_HTTP = "allow_http";
const PORT_RANGE = "published_port_range";
/** The ports published ones take unless the owner chose others (A74). */
export const DEFAULT_PORT_RANGE: PortRange = { from: 12600, to: 12699 };
const MAX_RANGE = 1000;

/** Where Jarvy listens and how it is reached, for the ports Bots publish (A74). */
export interface Listening { host: string; port: number; https: boolean; addresses: string[]; range: PortRange }

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
  portRange(): PortRange {
    const [from, to] = (this.store.settings.get(PORT_RANGE) ?? "").split("-").map(Number);
    return Number.isInteger(from) && Number.isInteger(to) ? { from: from!, to: to! } : DEFAULT_PORT_RANGE;
  }
  /** Ports already published keep theirs; new ones take from the new range. */
  setPortRange(value: unknown): ConnectionInfo {
    const range = value as Partial<PortRange> | null;
    const from = range?.from, to = range?.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from! < 1024 || to! > 65535 || from! > to! || to! - from! + 1 > MAX_RANGE)
      throw new ValidationError(`Ports are 1024-65535, from no more than to, at most ${MAX_RANGE} of them`, "port_range_invalid");
    if (this.listening && from! <= this.listening.port && this.listening.port <= to!) throw new ValidationError("The range can't include Jarvy's own port", "port_range_own");
    const same = from === DEFAULT_PORT_RANGE.from && to === DEFAULT_PORT_RANGE.to;
    this.store.settings.set(PORT_RANGE, same ? null : `${from}-${to}`);
    return this.info();
  }
  info(): ConnectionInfo {
    const listening = this.listening, material = this.material;
    const addresses = listening && material ? lanAddresses(listening.host).map(address => `https://${address.includes(":") ? `[${address}]` : address}:${listening.port}`) : [];
    return { https: !!material, allowHttp: this.allowHttp(), addresses, fingerprint: material?.fingerprint ?? null, fingerprintSha1: material?.fingerprintSha1 ?? null,
      ports: this.portRange() };
  }
  /** Null until Jarvy listens. `addresses`: hosts other devices may use, bare. */
  where(): Listening | null {
    const listening = this.listening;
    return listening ? { ...listening, https: !!this.material, addresses: lanAddresses(listening.host), range: this.portRange() } : null;
  }
  /** The root certificate (DER) for devices to install, when serving HTTPS. */
  rootCertificate(): Buffer | null { return this.material?.rootDer ?? null; }
}
