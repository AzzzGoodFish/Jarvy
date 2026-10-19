import { StringDecoder } from "node:string_decoder";

/** Masking (A52): every secret value Jarvy holds, and the forms it most often turns up in, replaced with its
 * placeholder `{{secret:NAME}}` wherever Jarvy passes text to a model or into the chat. It stops accidents, not a Bot
 * that transforms a value on purpose. */
export const placeholder = (name: string) => `{{secret:${name}}}`;
/** Values shorter than this aren't masked: they would match ordinary text. Settings warns below 8. */
export const MIN_MASKED = 4;
/** Base64 fragments shorter than this would match by chance. */
const MIN_FRAGMENT = 8;

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
/** The part of base64 that depends only on the value, when it starts `offset` bytes into the encoded data. */
function base64Fragments(value: string): string[] {
  const bytes = Buffer.from(value, "utf8"), found: string[] = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const fragment = encoded.slice(Math.ceil(offset * 8 / 6), Math.floor((offset + bytes.length) * 8 / 6));
    if (fragment.length >= MIN_FRAGMENT) found.push(fragment, fragment.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return found;
}
function forms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), xml(value), ...base64Fragments(value)];
}

export class Masker {
  /** Longest form first, so a form inside another is not replaced first. */
  private readonly pairs: { form: string; name: string }[];
  /** The longest form: streamed output holds back one less than this. */
  readonly longest: number;
  constructor(secrets: readonly { name: string; value: string }[]) {
    const pairs = new Map<string, string>();
    for (const { name, value } of secrets) if (value.length >= MIN_MASKED) for (const form of forms(value)) if (!pairs.has(form)) pairs.set(form, name);
    this.pairs = [...pairs].map(([form, name]) => ({ form, name })).sort((a, b) => b.form.length - a.form.length);
    this.longest = this.pairs[0]?.form.length ?? 0;
  }
  get empty() { return this.pairs.length === 0; }
  mask(text: string): string {
    let result = text;
    for (const { form, name } of this.pairs) if (result.includes(form)) result = result.split(form).join(placeholder(name));
    return result;
  }
  /** Every string inside a JSON-like value. */
  maskDeep<T>(value: T): T {
    if (this.empty) return value;
    if (typeof value === "string") return this.mask(value) as T;
    if (Array.isArray(value)) return value.map(item => this.maskDeep(item)) as T;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.maskDeep(item)])) as T;
    return value;
  }
}

/** Masks output as it streams: the last `longest - 1` characters wait for the next chunk, so a value split between
 * chunks is still caught, and `end` lets them out. Bytes are decoded as UTF-8 across chunk boundaries. */
export class StreamMask {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  constructor(private readonly masker: Masker, private readonly emit: (chunk: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.pending = this.masker.mask(this.pending + this.decoder.write(chunk));
    const keep = Math.max(0, this.masker.longest - 1), cut = Math.max(0, this.pending.length - keep);
    if (cut > 0) { this.emit(Buffer.from(this.pending.slice(0, cut))); this.pending = this.pending.slice(cut); }
  }
  end(): void {
    const rest = this.masker.mask(this.pending + this.decoder.end());
    this.pending = "";
    if (rest) this.emit(Buffer.from(rest));
  }
}
