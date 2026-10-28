import { ChatError } from "../../shared/chat.js";
import { type Attachment } from "../../../contract/chat.js";
import type { ToolMedia } from "../../shared/tools.js";
import { byteSize } from "../chat/files.js";

const TEXT_LIMIT = 64 * 1024;
const PICTURE_LIMIT = 4 * 1024 * 1024;

/** files.view (A50): a picture goes to the model as a picture, a short text file as its text; anything else is for
 * files.get. A model that can't see pictures is told so by Pi in place of the picture. Only the first bytes are read
 * to tell the kind, and the whole file only when it is small enough to show (A66). */
export async function viewFile(file: Attachment, contents: { head(file: Attachment, bytes: number): Promise<Buffer>; read(file: Attachment, limit: number): Promise<Buffer> }): Promise<ToolMedia | string> {
  const head = `${file.name} (${file.mimeType || "application/octet-stream"}, ${byteSize(file.size)})`;
  const picture = pictureType(await contents.head(file, 12));
  if (picture) {
    if (file.size > PICTURE_LIMIT) throw new ChatError(400, "This picture is over 4 MB; use files.get and look at a smaller copy");
    return { kind: "media", text: head, images: [{ data: (await contents.read(file, PICTURE_LIMIT)).toString("base64"), mimeType: picture }] };
  }
  const text = file.size <= TEXT_LIMIT ? asText(await contents.read(file, TEXT_LIMIT)) : null;
  if (text !== null) return `${head}\n\n${text}`;
  throw new ChatError(400, "files.view shows pictures and text files up to 64 KB; use files.get to work on this file with your tools");
}

/** The picture kinds models take, told by their first bytes. */
function pictureType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return null; }
}
