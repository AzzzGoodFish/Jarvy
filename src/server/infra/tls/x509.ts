import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/** Just enough DER to write Jarvy's own certificates (A51): a root that devices trust once and a server certificate
 * it signs. ECDSA P-256 with SHA-256 throughout; Node signs, and parses the result back as a check. */
const tlv = (tag: number, content: Buffer) => {
  const n = content.length;
  const length = n < 0x80 ? Buffer.from([n]) : (() => { const bytes: number[] = []; for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff); return Buffer.from([0x80 | bytes.length, ...bytes]); })();
  return Buffer.concat([Buffer.from([tag]), length, content]);
};
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const integer = (bytes: Buffer) => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const bits = (bytes: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const octets = (bytes: Buffer) => tlv(0x04, bytes);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const TRUE = tlv(0x01, Buffer.from([0xff]));
function oid(text: string): Buffer {
  const [a, b, ...rest] = text.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (common: string) => seq(set(seq(oid("2.5.4.10"), utf8("Jarvy"))), set(seq(oid("2.5.4.3"), utf8(common))));
const extension = (id: string, value: Buffer, critical = false) => seq(oid(id), ...(critical ? [TRUE] : []), octets(value));
const keyId = (key: KeyObject) => createHash("sha1").update(key.export({ type: "spki", format: "der" })).digest();

export function ipBytes(address: string): Buffer | null {
  if (isIPv4(address)) return Buffer.from(address.split(".").map(Number));
  if (!isIPv6(address) || address.includes(".")) return null;
  const [head, tail] = address.split("::");
  const groups = (part?: string) => part ? part.split(":") : [];
  const left = groups(head), right = groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return all.length === 8 ? Buffer.concat(all.map(group => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(group, 16)); return b; })) : null;
}
/** Host names as dNSName, addresses as iPAddress. */
const altNames = (names: string[]) => seq(...names.map(entry => { const ip = ipBytes(entry); return ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(entry, "ascii")); }));

export interface Issued { keyPem: string; certPem: string }
function issue(subject: KeyObject, signer: KeyObject, fields: { subject: string; issuer: string; days: number; extensions: Buffer[] }): string {
  const serial = randomBytes(16); serial[0]! &= 0x7f; serial[0]! |= 0x40;
  const notBefore = new Date(Date.now() - 24 * 3600_000), notAfter = new Date(Date.now() + fields.days * 24 * 3600_000);
  const tbs = seq(tlv(0xa0, integer(Buffer.from([2]))), integer(serial), ECDSA_SHA256, name(fields.issuer), seq(time(notBefore), time(notAfter)),
    name(fields.subject), subject.export({ type: "spki", format: "der" }), tlv(0xa3, seq(...fields.extensions)));
  const der = seq(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, signer)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;
}
const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }) as string;

/** The root: a CA that may sign server certificates only (path length 0), for ten years. */
export function makeRoot(label: string): Issued {
  const { publicKey, privateKey } = pair(), subject = `Jarvy local root (${label})`;
  const certPem = issue(publicKey, privateKey, { subject, issuer: subject, days: 3650, extensions: [
    extension("2.5.29.19", seq(TRUE, integer(Buffer.from([0]))), true),
    extension("2.5.29.15", bits(Buffer.from([0x06]), 1), true),
    extension("2.5.29.14", octets(keyId(publicKey))),
  ] });
  return { keyPem: pem(privateKey), certPem };
}
/** A server certificate for these names and addresses, signed by the root, for 397 days (the most Apple and browsers
 * accept for a TLS certificate). */
export function makeServer(root: Issued, names: string[]): Issued {
  const rootCert = new X509Certificate(root.certPem), rootKey = rootCert.publicKey;
  const { publicKey, privateKey } = pair();
  const issuer = rootCert.subject.split("\n").find(line => line.startsWith("CN="))!.slice(3);
  const certPem = issue(publicKey, createPrivateKey(root.keyPem), { subject: names[0]!, issuer, days: 397, extensions: [
    extension("2.5.29.19", seq(), true),
    extension("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
    extension("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))),
    extension("2.5.29.17", altNames(names)),
    extension("2.5.29.14", octets(keyId(publicKey))),
    extension("2.5.29.35", seq(tlv(0x80, keyId(rootKey)))),
  ] });
  const check = new X509Certificate(certPem);
  if (!check.checkIssued(rootCert) || !check.verify(rootKey)) throw new Error("The server certificate does not verify against Jarvy's root");
  return { keyPem: pem(privateKey), certPem };
}
