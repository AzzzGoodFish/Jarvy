/** What kind of picture a file's first bytes show, for Pi's read tool in any work environment (A50). Mirrors Pi 1.2.0's
 * `detectSupportedImageMimeType` (utils/mime.js), which the package does not export: the formats Pi passes to models,
 * without animated PNG or JPEG-LS. Keep it aligned when upgrading Pi. */
export const IMAGE_SNIFF_BYTES = 4100;

export function imageKind(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? null : "image/jpeg";
  if (startsWith(bytes, PNG)) return isPng(bytes) && !isAnimatedPng(bytes) ? "image/png" : null;
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "BM") && isBmp(bytes)) return "image/bmp";
  return null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) => bytes.length >= 16 && u32be(bytes, PNG.length) === 13 && ascii(bytes, 12, "IHDR");
function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = PNG.length;
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset), type = offset + 4;
    if (ascii(bytes, type, "acTL")) return true;
    if (ascii(bytes, type, "IDAT")) return false;
    const next = offset + 8 + length + 4;
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}
function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 26) return false;
  const size = u32le(bytes, 2), pixels = u32le(bytes, 10), header = u32le(bytes, 14);
  if (size !== 0 && size < 26) return false;
  if (pixels < 14 + header) return false;
  if (size !== 0 && pixels >= size) return false;
  let planes: number, bits: number;
  if (header === 12) { planes = u16le(bytes, 22); bits = u16le(bytes, 24); }
  else if (header >= 40 && header <= 124) {
    if (bytes.length < 30) return false;
    planes = u16le(bytes, 26); bits = u16le(bytes, 28);
  } else return false;
  return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}
const at = (bytes: Uint8Array, offset: number) => bytes[offset] ?? 0;
const u16le = (bytes: Uint8Array, offset: number) => at(bytes, offset) + (at(bytes, offset + 1) << 8);
const u32be = (bytes: Uint8Array, offset: number) => at(bytes, offset) * 0x1000000 + (at(bytes, offset + 1) << 16) + (at(bytes, offset + 2) << 8) + at(bytes, offset + 3);
const u32le = (bytes: Uint8Array, offset: number) => at(bytes, offset) + (at(bytes, offset + 1) << 8) + (at(bytes, offset + 2) << 16) + at(bytes, offset + 3) * 0x1000000;
const startsWith = (bytes: Uint8Array, prefix: number[]) => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}
