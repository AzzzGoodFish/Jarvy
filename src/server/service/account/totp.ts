import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Zero-dependency RFC 6238 TOTP (SHA-1, 6 digits, 30s period), recovery codes, and ISO 18004 QR SVG generator (A112). */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous chars (no 0/O/1/I)
const TOTP_PERIOD_S = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // accept +/- 1 step (90s total clock skew tolerance)

export function base32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[\s=-]+/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid Base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a 160-bit random Base32-encoded TOTP secret. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function buildOtpAuthUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function totpAt(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac[offset]! & 0x7f) << 24)
    | ((hmac[offset + 1]! & 0xff) << 16)
    | ((hmac[offset + 2]! & 0xff) << 8)
    | (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Verifies a 6-digit TOTP code against `secretBase32`. Returns the matched time step (for replay protection), or null. */
export function verifyTotp(secretBase32: string, rawCode: string, nowMs = Date.now(), lastUsedStep = -1): number | null {
  const normalized = rawCode.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
  const candidateBuf = Buffer.from(normalized, "utf8");
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = currentStep + delta;
    if (step <= lastUsedStep) continue;
    const expectedBuf = Buffer.from(totpAt(secretBase32, step), "utf8");
    if (timingSafeEqual(candidateBuf, expectedBuf)) return step;
  }
  return null;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let raw = "";
    for (let j = 0; j < 8; j++) raw += RECOVERY_ALPHABET[bytes[j]! % RECOVERY_ALPHABET.length]!;
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`jarvy-recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Compact ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1-10)
// ---------------------------------------------------------------------------

interface QrVersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  eccPerBlock: number;
  blocks: number;
  align: number[];
}

// ISO/IEC 18004 Table 9 for Error Correction Level L (supports up to 271 bytes at V10).
const QR_SPECS: QrVersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, eccPerBlock: 7, blocks: 1, align: [] },
  { version: 2, size: 25, dataCodewords: 34, eccPerBlock: 10, blocks: 1, align: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, eccPerBlock: 15, blocks: 1, align: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, eccPerBlock: 20, blocks: 1, align: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, eccPerBlock: 26, blocks: 1, align: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, eccPerBlock: 18, blocks: 2, align: [6, 34] },
  { version: 7, size: 45, dataCodewords: 156, eccPerBlock: 20, blocks: 2, align: [6, 22, 38] },
  { version: 8, size: 49, dataCodewords: 194, eccPerBlock: 24, blocks: 2, align: [6, 24, 42] },
  { version: 9, size: 53, dataCodewords: 232, eccPerBlock: 30, blocks: 2, align: [6, 26, 46] },
  { version: 10, size: 57, dataCodewords: 274, eccPerBlock: 18, blocks: 4, align: [6, 28, 50] },
];

// Version information bits (BCH(18,6)) for versions 7-10.
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

function gfMul(a: number, b: number): number {
  let res = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) res ^= x;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    y >>= 1;
  }
  return res;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, root);
    }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly.slice(1); // drop leading 1
}

function rsComputeEcc(data: number[], eccLen: number): number[] {
  const gen = rsGeneratorPoly(eccLen);
  const rem = new Array<number>(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let i = 0; i < eccLen; i++) rem[i] = rem[i]! ^ gfMul(gen[i]!, factor);
  }
  return rem;
}

function formatBits(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= poly << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function encodeQrMatrix(text: string): boolean[][] {
  const payload = Buffer.from(text, "utf8");
  const spec = QR_SPECS.find(s => {
    const countBits = s.version >= 10 ? 16 : 8;
    const totalBits = 4 + countBits + payload.length * 8;
    return Math.ceil(totalBits / 8) <= s.dataCodewords;
  });
  if (!spec) throw new Error("QR payload too long");

  // 1. Build data bit stream (Byte mode = 0100)
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(payload.length, spec.version >= 10 ? 16 : 8);
  for (const b of payload) pushBits(b, 8);
  const capBits = spec.dataCodewords * 8;
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    dataBytes.push(byte);
  }
  const padBytes = [0xec, 0x11];
  for (let i = 0; dataBytes.length < spec.dataCodewords; i++) dataBytes.push(padBytes[i % 2]!);

  // 2. Split into RS blocks (for V1-V10 Level L: V1-5=1 block, V6-9=2 blocks, V10=4 blocks (2x68 + 2x69))
  const shortBlockLen = Math.floor(spec.dataCodewords / spec.blocks);
  const longBlocks = spec.dataCodewords % spec.blocks;
  const shortBlocks = spec.blocks - longBlocks;
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let cursor = 0;
  for (let b = 0; b < spec.blocks; b++) {
    const len = shortBlockLen + (b >= shortBlocks ? 1 : 0);
    const slice = dataBytes.slice(cursor, cursor + len);
    cursor += len;
    dataBlocks.push(slice);
    eccBlocks.push(rsComputeEcc(slice, spec.eccPerBlock));
  }

  // Interleave codewords
  const codewords: number[] = [];
  const maxBlockLen = shortBlockLen + (longBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxBlockLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) codewords.push(blk[i]!);
  }
  for (let i = 0; i < spec.eccPerBlock; i++) {
    for (const ecc of eccBlocks) codewords.push(ecc[i]!);
  }

  // 3. Place function patterns
  const n = spec.size;
  const grid: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const reserved: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < n && c >= 0 && c < n) { grid[r]![c] = dark; reserved[r]![c] = true; }
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const border = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const dark = !border && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const r of spec.align) {
    for (const c of spec.align) {
      if (reserved[r]![c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(r + dr, c + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (!reserved[8]![i]) setFunc(8, i, false);
      if (!reserved[i]![8]) setFunc(i, 8, false);
    }
  }
  for (let i = n - 8; i < n; i++) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(n - 8, 8, true); // dark module

  // Version info for >= 7
  const vInfo = VERSION_INFO[spec.version];
  if (vInfo !== undefined) {
    for (let i = 0; i < 18; i++) {
      const bit = ((vInfo >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // 4. Zig-zag data placement
  let bitIdx = 0;
  const totalDataBits = codewords.length * 8;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (reserved[r]![c]) continue;
        let dark = false;
        if (bitIdx < totalDataBits) {
          dark = ((codewords[bitIdx >> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        grid[r]![c] = dark;
      }
    }
    upward = !upward;
  }

  // 5. Evaluate mask patterns 0..7 and pick lowest penalty
  const maskFn = (m: number, r: number, c: number): boolean => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const applyFormat = (mat: boolean[][], mask: number) => {
    const f = formatBits(mask);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) mat[8]![i] = bit(14 - i);
    mat[8]![7] = bit(8);
    mat[8]![8] = bit(7);
    mat[7]![8] = bit(6);
    for (let i = 9; i < 15; i++) mat[14 - i]![8] = bit(14 - i);
    for (let i = 0; i < 8; i++) mat[8]![n - 1 - i] = bit(i);
    for (let i = 0; i < 7; i++) mat[n - 1 - i]![8] = bit(14 - i);
  };

  let bestGrid = grid;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    const cand = grid.map((row, r) => row.map((v, c) => (reserved[r]![c] ? v : v !== maskFn(m, r, c))));
    applyFormat(cand, m);
    let penalty = 0;
    // Rule 1: adjacent runs >= 5
    for (let r = 0; r < n; r++) {
      let runRow = 1;
      let runCol = 1;
      for (let c = 1; c < n; c++) {
        if (cand[r]![c] === cand[r]![c - 1]) { runRow++; if (runRow === 5) penalty += 3; else if (runRow > 5) penalty += 1; } else runRow = 1;
        if (cand[c]![r] === cand[c - 1]![r]) { runCol++; if (runCol === 5) penalty += 3; else if (runCol > 5) penalty += 1; } else runCol = 1;
      }
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = cand[r]![c];
        if (v === cand[r]![c + 1] && v === cand[r + 1]![c] && v === cand[r + 1]![c + 1]) penalty += 3;
      }
    }
    if (penalty < bestPenalty) { bestPenalty = penalty; bestGrid = cand; }
  }
  return bestGrid;
}

/** Renders an ISO 18004 QR code as a compact self-contained SVG string with quiet zone. */
export function renderQrSvg(text: string): string {
  const matrix = encodeQrMatrix(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r]![c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${parts.join("")}" fill="#000"/></svg>`;
}
