/** How an attachment goes out (A34, A35): always as a download (`Content-Disposition: attachment`, nosniff), with its
 * own type only for the audio and video formats the preview plays — never for HTML, SVG or anything else a browser
 * could run — and with single byte ranges, so a media element can seek. */
const MEDIA_TYPES = new Set(["video/webm", "video/mp4", "video/quicktime", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/mp4"]);

export function downloadType(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  return MEDIA_TYPES.has(type) ? type : "application/octet-stream";
}

/** One `Range: bytes=…` against a file of `size` bytes: the inclusive span to send, "unsatisfiable" (416), or null to
 * send the whole file (no header, another unit, several ranges, or a malformed one — RFC 9110 lets a server ignore
 * those). An end past the file is cut to its last byte. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : Infinity;
  if (end < start) return null;
  return start >= size ? "unsatisfiable" : { start, end: Math.min(end, size - 1) };
}
