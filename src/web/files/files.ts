import type { Attachment } from "../../contract/chat";
import { t } from "../i18n";

/** Preview kinds; larger files are download-only, except audio and video, which stream (A34). */
export type FileKind = "image" | "svg" | "video" | "audio" | "html" | "markdown" | "text" | "download";
export const PREVIEW_LIMIT = 1024 * 1024;
const TEXT = ["txt", "json", "jsonl", "yaml", "yml", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "log", "csv", "py", "sh", "sql", "toml", "xml", "ini", "env", "diff", "patch"];

export const fileUrl = (file: Attachment) => `/api/attachments/${file.id}`;
export const extension = (file: Attachment) => file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
export function fileKind(file: Attachment): FileKind {
  const ext = extension(file), mime = file.mimeType.toLowerCase();
  if (ext === "svg" || mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext)) return "image";
  // The type first, so an audio-only .webm is audio.
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (["webm", "mp4", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg"].includes(ext)) return "audio";
  if (["html", "htm"].includes(ext) || mime === "text/html") return "html";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (mime.startsWith("text/") || TEXT.includes(ext)) return "text";
  return "download";
}
export const isPicture = (kind: FileKind) => kind === "image" || kind === "svg";
/** Audio and video play from the attachment URL: the element reads it in byte ranges, never the whole file first. */
export const isMedia = (kind: FileKind): kind is "video" | "audio" => kind === "video" || kind === "audio";
export const KIND_LABEL = { image: "files.kindImage", svg: "files.kindSvg", video: "files.kindVideo", audio: "files.kindAudio", html: "files.kindHtml",
  markdown: "files.kindMarkdown", text: "files.kindText", download: "files.kindFile" } as const;
export function bytes(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
/** Attachments are served as same-origin octet-stream downloads; text is read through fetch. */
export async function readText(file: Attachment, signal?: AbortSignal) {
  const response = await fetch(fileUrl(file), { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 404 ? t("files.gone") : t("files.readFailed", { status: response.status }));
  return response.text();
}
/** Raster images load straight from the attachment URL (browsers sniff them). SVG is not sniffed, so it
 * becomes a data: URL — allowed by the page CSP, and an <img> never runs SVG scripts. */
export async function pictureSource(file: Attachment, signal?: AbortSignal) {
  return fileKind(file) === "svg" ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await readText(file, signal))}` : fileUrl(file);
}
export const runUrl = (file: Attachment) => `/api/attachments/${file.id}/run`;
/** What running an HTML file would add to its static rendering (A35): script elements, inline event
 * handlers and javascript: links, plus the outside hosts it loads from. null = nothing to run. */
export function scriptReport(text: string): { count: number; hosts: string[] } | null {
  const doc = new DOMParser().parseFromString(text, "text/html");
  let count = doc.querySelectorAll("script").length;
  const hosts = new Set<string>();
  doc.querySelectorAll("*").forEach(el => {
    for (const attribute of [...el.attributes]) {
      if (attribute.name.startsWith("on")) count++;
      else if (/^\s*javascript:/i.test(attribute.value) && ["href", "src", "action", "formaction", "xlink:href"].includes(attribute.name)) count++;
      else if (["src", "href"].includes(attribute.name) && el.tagName !== "A") {
        try { const url = new URL(attribute.value); if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host); } catch { /* relative or invalid */ }
      }
    }
  });
  return count ? { count, hosts: [...hosts] } : null;
}
/** Static rendering of an untrusted HTML file: scripts, frames, external loads and
 * handlers are removed, then it is shown in a sandbox="" iframe with its own deny-all CSP. */
export function safeHtml(text: string) {
  const parsed = new DOMParser().parseFromString(text, "text/html");
  parsed.querySelectorAll("script,iframe,frame,object,embed,link,meta,base,audio,video,source,track").forEach(el => el.remove());
  parsed.querySelectorAll("*").forEach(el => {
    for (const attribute of [...el.attributes]) {
      if (attribute.name.startsWith("on") || ["href", "xlink:href", "srcset", "action", "formaction", "target", "autofocus", "contenteditable"].includes(attribute.name)
        || (attribute.name === "src" && !attribute.value.startsWith("data:image/"))) el.removeAttribute(attribute.name);
    }
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) el.setAttribute("disabled", "");
  });
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><meta charset="utf-8">${parsed.documentElement.outerHTML}`;
}
