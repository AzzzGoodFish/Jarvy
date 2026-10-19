import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { ipBytes, makeRoot, makeServer, type Issued } from "./x509.js";
import type { Cipher } from "../vault/cipher.js";

/** Jarvy's certificates in the data directory (A51): the root devices trust once, kept for ten years, and the server
 * certificate, signed again at start when it nears its end or the names it must cover changed. Private keys are
 * sealed under the master key (A52), so a copy of the data directory alone does not carry them. */
export interface TlsMaterial {
  key: string; cert: string;
  /** The root, for devices to install. */
  rootDer: Buffer;
  /** SHA-256 of the root as browsers show it, colon-separated hex. */
  fingerprint: string;
  names: string[];
}
const RENEW_MS = 30 * 24 * 3600_000;

export const isLoopbackHost = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);
/** Interfaces of containers, VMs and proxy tunnels on this machine, which other devices don't use to reach it; and the
 * benchmarking range such tunnels take their addresses from. */
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|vhs|lxc|lxd|cni|flannel|cali|tun|utun|meta|clash)/i;
const TUNNEL = /^198\.1[89]\./;
/** Wired and wireless interfaces first, IPv4 before IPv6. */
const rank = (name: string, family: string) => (/^(en|eth|wl|bond)/.test(name) ? 0 : 2) + (family === "IPv4" ? 0 : 1);
const reachable = () => Object.entries(networkInterfaces()).filter(([name]) => !VIRTUAL.test(name))
  .flatMap(([name, list]) => (list ?? []).filter(item => !item.internal && !TUNNEL.test(item.address) && (item.family === "IPv4" || !item.address.startsWith("fe80")))
    .map(item => ({ address: item.address, order: rank(name, item.family) })))
  .sort((a, b) => a.order - b.order).map(item => item.address);
/** Addresses other devices may use to reach this machine. */
export function lanAddresses(host: string): string[] {
  if (host !== "0.0.0.0" && host !== "::") return isLoopbackHost(host) ? [] : [host];
  return reachable();
}
/** Every name and address the server may be reached at: this machine by name, this machine itself, its LAN addresses,
 * and the host it was told to listen on. */
function coveredNames(host: string): string[] {
  const machine = hostname().toLowerCase(), label = /^[a-z0-9-]+$/.test(machine) ? [machine, `${machine}.local`] : [];
  return [...new Set([...label, "localhost", "127.0.0.1", "::1", ...reachable(), ...(host === "0.0.0.0" || host === "::" ? [] : [host])])];
}
/** Addresses compared by their bytes: a certificate lists ::1 as 0:0:0:0:0:0:0:1. */
const canonical = (entry: string) => ipBytes(entry)?.toString("hex") ?? entry.toLowerCase();

function read(dir: string, file: string): string | null { const path = join(dir, file); return existsSync(path) ? readFileSync(path, "utf8") : null; }
function write(dir: string, file: string, text: string, secret: boolean) { writeFileSync(join(dir, file), text, { mode: secret ? 0o600 : 0o644 }); }
/** A private key: `<name>.sealed` under the master key; a plain `<name>.pem` from before A52 is sealed and removed. */
function readKey(dir: string, name: string, cipher: Cipher, log: (text: string) => void): string | null {
  const plain = read(dir, `${name}.pem`);
  if (plain) { writeKey(dir, name, plain, cipher); rmSync(join(dir, `${name}.pem`)); return plain; }
  const sealed = read(dir, `${name}.sealed`);
  if (!sealed) return null;
  const opened = cipher.open(sealed.trim(), `tls:${name}`);
  if (opened === null) log(`[tls] ${name} doesn't open with this installation's master key; making a new one`);
  return opened;
}
function writeKey(dir: string, name: string, pem: string, cipher: Cipher) { write(dir, `${name}.sealed`, `${cipher.seal(pem, `tls:${name}`)}\n`, true); }

/** The certificate to serve when listening on `host`, making or renewing what is needed. */
export function certificates(dataDir: string, host: string, cipher: Cipher, log: (text: string) => void = console.log): TlsMaterial {
  const dir = join(dataDir, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let root: Issued | null = null;
  const rootKey = readKey(dir, "root-key", cipher, log), rootCert = read(dir, "root.pem");
  if (rootKey && rootCert && new X509Certificate(rootCert).validToDate.getTime() - Date.now() > RENEW_MS) root = { keyPem: rootKey, certPem: rootCert };
  const names = coveredNames(host);
  let server: Issued | null = null;
  if (root) {
    const key = readKey(dir, "server-key", cipher, log), cert = read(dir, "server.pem");
    if (key && cert) {
      const parsed = new X509Certificate(cert);
      const covers = new Set((parsed.subjectAltName ?? "").split(", ").map(entry => canonical(entry.replace(/^(DNS|IP Address):/, ""))));
      const fresh = parsed.validToDate.getTime() - Date.now() > RENEW_MS && parsed.checkIssued(new X509Certificate(root.certPem));
      if (fresh && names.every(entry => covers.has(canonical(entry)))) server = { keyPem: key, certPem: cert };
    }
  } else {
    root = makeRoot(hostname());
    writeKey(dir, "root-key", root.keyPem, cipher); write(dir, "root.pem", root.certPem, false);
    log("[tls] made a new root certificate; devices need to trust it once");
  }
  if (!server) {
    server = makeServer(root, names);
    writeKey(dir, "server-key", server.keyPem, cipher); write(dir, "server.pem", server.certPem, false);
    log(`[tls] signed a server certificate for ${names.join(", ")}`);
  }
  const parsedRoot = new X509Certificate(root.certPem);
  return { key: server.keyPem, cert: server.certPem, rootDer: parsedRoot.raw, fingerprint: parsedRoot.fingerprint256, names };
}
