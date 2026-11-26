import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/** Client-side AES-256-GCM envelope encryption for cloud storage objects (A107).
 * Wire format: `[4B magic "JVY1"] [1B flags: bit0=gzip] [12B IV] [ciphertext] [16B GCM auth tag]`.
 * Associated data (AAD) binds each ciphertext strictly to its S3 object key (`jarvy-cloud:v1:<key>`). */

const MAGIC = Buffer.from("JVY1", "ascii");
const FLAG_GZIP = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;
const VERIFY_TEXT = "jarvy-cloud-vault-v1";
const KEY_PREFIX = "jarvy:v1:";

export interface CloudVaultMeta {
  version: 1;
  kdf: "raw" | "scrypt";
  salt: string;
  verify: string;
  installationId: string;
  createdAt: number;
}

/** Generates a fresh 256-bit recovery key suitable for `JARVY_RECOVERY_KEY` / `--recovery-key`. */
export function generateRecoveryKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64")}`;
}

/** Derives a 32-byte AES key from either a `jarvy:v1:<base64-32B>` key or a human passphrase (via scrypt). */
export function deriveCloudKey(recoveryKey: string, saltBase64: string): { key: Buffer; kdf: "raw" | "scrypt" } {
  const trimmed = recoveryKey.trim();
  if (!trimmed) throw new Error("Cloud recovery key cannot be empty");
  if (trimmed.startsWith(KEY_PREFIX)) {
    const raw = Buffer.from(trimmed.slice(KEY_PREFIX.length), "base64");
    if (raw.length !== 32) throw new Error("Invalid jarvy:v1 recovery key (expected 32 base64 bytes)");
    return { key: raw, kdf: "raw" };
  }
  const salt = Buffer.from(saltBase64, "base64");
  if (salt.length < 16) throw new Error("Invalid vault salt");
  const derived = scryptSync(trimmed, salt, 32, { N: 16_384, r: 8, p: 1 });
  return { key: derived, kdf: "scrypt" };
}

export function createVaultMeta(recoveryKey: string, installationId: string): { meta: CloudVaultMeta; key: Buffer } {
  const salt = randomBytes(16).toString("base64");
  const { key, kdf } = deriveCloudKey(recoveryKey, salt);
  const verify = encryptEnvelope(Buffer.from(VERIFY_TEXT, "utf8"), key, "meta/vault.verify", false).toString("base64");
  return {
    key,
    meta: { version: 1, kdf, salt, verify, installationId, createdAt: Date.now() },
  };
}

export function openVaultMeta(meta: CloudVaultMeta, recoveryKey: string): Buffer {
  if (meta.version !== 1) throw new Error(`Unsupported cloud vault version: ${String(meta.version)}`);
  const { key } = deriveCloudKey(recoveryKey, meta.salt);
  try {
    const plain = decryptEnvelope(Buffer.from(meta.verify, "base64"), key, "meta/vault.verify").toString("utf8");
    if (plain !== VERIFY_TEXT) throw new Error("mismatch");
    return key;
  } catch {
    throw new Error("Wrong recovery key for this cloud storage bucket");
  }
}

export function encryptEnvelope(plain: Buffer | Uint8Array, key: Buffer, objectKey: string, compress = true): Buffer {
  const input = Buffer.isBuffer(plain) ? plain : Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
  let payload = input;
  let flags = 0;
  if (compress && input.length >= 64) {
    const zipped = gzipSync(input, { level: 6 });
    if (zipped.length < input.length) {
      payload = zipped;
      flags |= FLAG_GZIP;
    }
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([flags]), iv, encrypted, tag]);
}

export function decryptEnvelope(envelope: Buffer, key: Buffer, objectKey: string): Buffer {
  if (envelope.length < HEADER_BYTES + TAG_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`Corrupt cloud envelope for ${objectKey}`);
  }
  const flags = envelope[MAGIC.length]!;
  const iv = envelope.subarray(MAGIC.length + 1, HEADER_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
  decipher.setAuthTag(tag);
  const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return (flags & FLAG_GZIP) ? gunzipSync(payload) : payload;
}
