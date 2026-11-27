import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGzip, gunzipSync, gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

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
    const zipped = gzipSync(input, { level: 3 });
    if (zipped.length < input.length) {
      payload = zipped;
      flags |= FLAG_GZIP;
    }
  }
  return sealPayload(payload, flags, key, objectKey);
}

/** Non-blocking envelope encryption for medium/large buffers (runs gzip on libuv threadpool). */
export async function encryptEnvelopeAsync(plain: Buffer | Uint8Array, key: Buffer, objectKey: string, compress = true): Promise<Buffer> {
  const input = Buffer.isBuffer(plain) ? plain : Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
  let payload = input;
  let flags = 0;
  if (compress && input.length >= 64) {
    const zipped = await gzipAsync(input, { level: 3 });
    if (zipped.length < input.length) {
      payload = zipped;
      flags |= FLAG_GZIP;
    }
  }
  return sealPayload(payload, flags, key, objectKey);
}

/** Streaming SHA-256 hash of a file on disk without loading it into memory. */
export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Streaming file → gzip(level 3) → AES-256-GCM envelope encryption. Avoids loading multi-hundred-MB
 * SQLite snapshots into RAM and keeps the Node event loop responsive on small 2 GB VPS hosts. */
export function encryptFileEnvelope(filePath: string, key: Buffer, objectKey: string, compress = true): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const iv = randomBytes(IV_BYTES);
    const flags = compress ? FLAG_GZIP : 0;
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header[MAGIC.length] = flags;
    iv.copy(header, MAGIC.length + 1);
    const chunks: Buffer[] = [header];
    const src = createReadStream(filePath, { highWaterMark: 256 * 1024 });
    const z = compress ? createGzip({ level: 3 }) : null;
    const fail = (err: Error) => { src.destroy(); z?.destroy(); cipher.destroy(); reject(err); };
    src.on("error", fail);
    cipher.on("error", fail);
    cipher.on("data", (chunk: Buffer) => chunks.push(chunk));
    cipher.on("end", () => {
      chunks.push(cipher.getAuthTag());
      resolve(Buffer.concat(chunks));
    });
    if (z) {
      z.on("error", fail);
      src.pipe(z).pipe(cipher);
    } else {
      src.pipe(cipher);
    }
  });
}

function sealPayload(payload: Buffer, flags: number, key: Buffer, objectKey: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length + TAG_BYTES);
  MAGIC.copy(out, 0);
  out[MAGIC.length] = flags;
  iv.copy(out, MAGIC.length + 1);
  const c1 = cipher.update(payload);
  c1.copy(out, HEADER_BYTES);
  const c2 = cipher.final();
  c2.copy(out, HEADER_BYTES + c1.length);
  cipher.getAuthTag().copy(out, HEADER_BYTES + c1.length + c2.length);
  return out;
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
