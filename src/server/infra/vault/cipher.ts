import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { MasterKey } from "./master-key.js";

/** AES-256-GCM under the master key (A52). Each value is bound to where it is stored (`context`, such as
 * `secret:<id>`), so a sealed value moved to another row does not open. Sealed text is `enc:v1:` and base64 of
 * IV (12 bytes), ciphertext and tag (16 bytes). */
const PREFIX = "enc:v1:";
export class Cipher {
  private loaded: MasterKey | null = null;
  constructor(private readonly load: () => MasterKey, private readonly log: (text: string) => void = console.log) {}
  private get master(): MasterKey {
    if (!this.loaded) {
      this.loaded = this.load();
      if (this.loaded.created) this.log(`[vault] made a new master key at ${this.loaded.location}; back it up with the data directory`);
    }
    return this.loaded;
  }
  location(): string { return this.master.location; }
  static sealed(text: string): boolean { return text.startsWith(PREFIX); }
  seal(plain: string, context: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.master.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }
  /** The plain text, or null when it does not open under this key (another installation's key, or damaged). */
  open(sealed: string, context: string): string | null {
    if (!Cipher.sealed(sealed)) return null;
    try {
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.master.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    } catch { return null; }
  }
  /** A short keyed fingerprint for people and logs: it tells values apart without letting anyone test guesses. */
  fingerprint(plain: string): string { return createHmac("sha256", this.master.key).update(plain).digest("hex").slice(0, 8); }
}
