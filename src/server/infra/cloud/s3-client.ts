import { createHash, createHmac } from "node:crypto";
import { combineSignals } from "../../shared/shutdown.js";

/** Minimal zero-dependency S3 Signature Version 4 client (A107).
 * Compatible with Cloudflare R2, Aliyun OSS, Tencent COS, Backblaze B2, AWS S3, MinIO, and Garage.
 * Supports conditional writes (`If-Match`/`If-None-Match`), Range reads, paginated listing, and Pre-signed URLs. */

const DEFAULT_S3_TIMEOUT_MS = 30_000;

export interface S3ClientConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle?: boolean;
  /** Default per-request HTTP timeout in milliseconds (A114; defaults to 30 s). */
  timeoutMs?: number;
}

export interface S3ObjectMeta {
  key: string;
  size: number;
  etag: string;
  lastModified?: string;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export class S3ConflictError extends S3Error {
  constructor(status: number, message: string) {
    super(status, "PreconditionFailed", message);
    this.name = "S3ConflictError";
  }
}

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string, keyPrefix: string, service: string, terminal: string): Buffer {
  const kDate = hmac(`${keyPrefix}${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, terminal);
}

interface SignScheme {
  algo: string;
  keyPrefix: string;
  headerPrefix: string;
  queryPrefix: string;
  service: string;
  terminal: string;
}

const AWS4_SCHEME: SignScheme = { algo: "AWS4-HMAC-SHA256", keyPrefix: "AWS4", headerPrefix: "x-amz", queryPrefix: "X-Amz", service: "s3", terminal: "aws4_request" };
const GOOG4_SCHEME: SignScheme = { algo: "GOOG4-HMAC-SHA256", keyPrefix: "GOOG4", headerPrefix: "x-goog", queryPrefix: "X-Goog", service: "storage", terminal: "goog4_request" };

function isGcsHost(hostname: string): boolean {
  return hostname === "storage.googleapis.com" || hostname.endsWith(".storage.googleapis.com");
}

function shouldUsePathStyle(endpoint: URL, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const host = endpoint.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return Boolean(endpoint.port);
}

function normalizeEtag(raw: string | null): string {
  return (raw ?? "").trim();
}

export class S3Client {
  private readonly endpointUrl: URL;
  private readonly pathStyle: boolean;
  private readonly isGcs: boolean;
  private readonly scheme: SignScheme;
  private readonly timeoutMs: number;

  constructor(private readonly config: S3ClientConfig) {
    this.endpointUrl = new URL(config.endpoint);
    this.pathStyle = shouldUsePathStyle(this.endpointUrl, config.pathStyle);
    this.isGcs = isGcsHost(this.endpointUrl.hostname);
    this.scheme = this.isGcs ? GOOG4_SCHEME : AWS4_SCHEME;
    this.timeoutMs = Math.max(1_000, config.timeoutMs ?? DEFAULT_S3_TIMEOUT_MS);
  }

  private extractVersion(res: Response): string {
    if (this.isGcs) {
      const gen = res.headers.get("x-goog-generation")?.trim();
      if (gen) return `gcs-gen:${gen}`;
    }
    return normalizeEtag(res.headers.get("etag"));
  }

  private target(key: string, query: Record<string, string> = {}): { url: URL; canonicalUri: string; canonicalQuery: string; host: string } {
    const cleanKey = key.replace(/^\/+/, "");
    const url = new URL(this.endpointUrl.toString());
    const basePath = url.pathname.replace(/\/+$/, "");
    let canonicalUri: string;
    if (this.pathStyle) {
      canonicalUri = cleanKey
        ? `${basePath}/${encodeRfc3986(this.config.bucket)}/${encodeKeyPath(cleanKey)}`
        : `${basePath}/${encodeRfc3986(this.config.bucket)}`;
    } else {
      url.hostname = `${this.config.bucket}.${url.hostname}`;
      canonicalUri = cleanKey ? `${basePath}/${encodeKeyPath(cleanKey)}` : `${basePath}/`;
    }
    url.pathname = canonicalUri;

    const pairs = Object.entries(query)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`);
    const canonicalQuery = pairs.join("&");
    url.search = canonicalQuery ? `?${canonicalQuery}` : "";
    return { url, canonicalUri, canonicalQuery, host: url.host };
  }

  private signHeaders(
    method: string,
    canonicalUri: string,
    canonicalQuery: string,
    host: string,
    payloadHash: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const { amzDate, dateStamp } = formatAmzDate(new Date());
    const s = this.scheme;
    const headers: Record<string, string> = {
      host,
      [`${s.headerPrefix}-content-sha256`]: payloadHash,
      [`${s.headerPrefix}-date`]: amzDate,
    };
    for (const [k, v] of Object.entries(extra)) {
      headers[k.toLowerCase()] = v.trim();
    }
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join("");
    const signedHeaders = sortedKeys.join(";");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.config.region}/${s.service}/${s.terminal}`;
    const stringToSign = [s.algo, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, dateStamp, this.config.region, s.keyPrefix, s.service, s.terminal))
      .update(stringToSign)
      .digest("hex");
    headers.authorization = `${s.algo} Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return headers;
  }

  private async send(
    method: string,
    key: string,
    options: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Uint8Array;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const { url, canonicalUri, canonicalQuery, host } = this.target(key, options.query);
    const body = options.body;
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");
    const headers = this.signHeaders(method, canonicalUri, canonicalQuery, host, payloadHash, options.headers);
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) } : {}),
      signal: combineSignals(this.timeoutMs, options.signal),
    });
    return res;
  }

  async head(key: string, signal?: AbortSignal): Promise<{ etag: string; size: number; lastModified?: string } | null> {
    const res = await this.send("HEAD", key, { signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await toS3Error(res, `HEAD ${key}`);
    return {
      etag: this.extractVersion(res),
      size: Number(res.headers.get("content-length") ?? "0"),
      ...(res.headers.get("last-modified") ? { lastModified: res.headers.get("last-modified")! } : {}),
    };
  }

  async get(
    key: string,
    options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
  ): Promise<{ body: Buffer; etag: string; size: number } | null> {
    const headers: Record<string, string> = {};
    if (options.range) headers.range = `bytes=${options.range.start}-${options.range.end}`;
    const res = await this.send("GET", key, { headers, signal: options.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await toS3Error(res, `GET ${key}`);
    const body = Buffer.from(await res.arrayBuffer());
    return { body, etag: this.extractVersion(res), size: body.length };
  }

  async put(
    key: string,
    body: Buffer | Uint8Array,
    options: { ifMatch?: string; ifNoneMatch?: string; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<{ etag: string }> {
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/octet-stream",
    };
    if (this.isGcs) {
      if (options.ifNoneMatch === "*") headers["x-goog-if-generation-match"] = "0";
      else if (options.ifMatch) {
        const gen = options.ifMatch.startsWith("gcs-gen:") ? options.ifMatch.slice(8) : /^\d+$/.test(options.ifMatch) ? options.ifMatch : "1";
        headers["x-goog-if-generation-match"] = gen;
      }
    } else {
      if (options.ifMatch) headers["if-match"] = options.ifMatch;
      if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
    }
    const res = await this.send("PUT", key, { headers, body, signal: options.signal });
    if (res.status === 412 || res.status === 409) {
      const text = await res.text().catch(() => "");
      throw new S3ConflictError(res.status, `S3 conditional PUT conflict on ${key} (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw await toS3Error(res, `PUT ${key}`);
    return { etag: this.extractVersion(res) };
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send("DELETE", key, { signal });
    if (res.status === 404 || res.status === 204 || res.ok) return;
    throw await toS3Error(res, `DELETE ${key}`);
  }

  async list(prefix: string, signal?: AbortSignal): Promise<S3ObjectMeta[]> {
    const results: S3ObjectMeta[] = [];
    let continuationToken: string | undefined;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const res = await this.send("GET", "", { query, signal });
      if (!res.ok) throw await toS3Error(res, `LIST ${prefix}`);
      const xml = await res.text();
      for (const item of parseListObjectsXml(xml)) results.push(item);
      const truncated = extractTag(xml, "IsTruncated") === "true";
      const next = extractTag(xml, "NextContinuationToken");
      if (!truncated || !next) break;
      continuationToken = next;
    }
    return results;
  }

  /** Generates a SigV4 / GOOG4 query-authenticated Pre-signed URL (used by Phase 3 remote compute nodes for direct S3 sync). */
  presign(method: "GET" | "PUT", key: string, expiresSeconds = 900): string {
    const { amzDate, dateStamp } = formatAmzDate(new Date());
    const s = this.scheme;
    const scope = `${dateStamp}/${this.config.region}/${s.service}/${s.terminal}`;
    const baseQuery: Record<string, string> = {
      [`${s.queryPrefix}-Algorithm`]: s.algo,
      [`${s.queryPrefix}-Credential`]: `${this.config.accessKeyId}/${scope}`,
      [`${s.queryPrefix}-Date`]: amzDate,
      [`${s.queryPrefix}-Expires`]: String(Math.max(1, Math.min(604_800, Math.floor(expiresSeconds)))),
      [`${s.queryPrefix}-SignedHeaders`]: "host",
    };
    const { url, canonicalUri, canonicalQuery, host } = this.target(key, baseQuery);
    const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = [s.algo, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, dateStamp, this.config.region, s.keyPrefix, s.service, s.terminal))
      .update(stringToSign)
      .digest("hex");
    url.search = `?${canonicalQuery}&${s.queryPrefix}-Signature=${signature}`;
    return url.toString();
  }
}

async function toS3Error(res: Response, action: string): Promise<S3Error> {
  const text = await res.text().catch(() => "");
  const code = extractTag(text, "Code") ?? `HTTP_${res.status}`;
  const msg = extractTag(text, "Message") ?? text.slice(0, 240) ?? res.statusText;
  return new S3Error(res.status, code, `S3 ${action} failed (${res.status} ${code}): ${msg}`);
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : null;
}

function parseListObjectsXml(xml: string): S3ObjectMeta[] {
  const out: S3ObjectMeta[] = [];
  const pattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const block = match[1]!;
    const key = extractTag(block, "Key");
    if (!key) continue;
    const size = Number(extractTag(block, "Size") ?? "0");
    const etag = extractTag(block, "ETag") ?? "";
    const lastModified = extractTag(block, "LastModified") ?? undefined;
    out.push({ key, size, etag, ...(lastModified ? { lastModified } : {}) });
  }
  return out;
}
