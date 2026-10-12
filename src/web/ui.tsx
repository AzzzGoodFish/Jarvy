import { memo, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AppWindow, ArrowUp, Bell, BellOff, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Eye, EyeOff, File, Folder,
  Expand, Image, Info, List, LogOut, MessageCircle, Moon, PanelLeft, Paperclip, Pencil, Megaphone, Trash2, Pin, Quote, Plus, Reply,
  Search, Settings, Shrink, SmilePlus, Sun, UserPlus, Users, X, type LucideIcon } from "lucide-react";

export function applyTheme(mode: "light" | "dark"): void {
  // Tokens live in styles/tokens.css; shadcn components follow the `dark` class.
  document.documentElement.dataset.theme = mode;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.style.colorScheme = mode;
  localStorage.setItem("jarvy-theme", mode);
}
/** The app's icon names, drawn with Lucide. */
const ICONS: Record<string, LucideIcon> = {
  add: Plus, "chat-bubble": MessageCircle, window: AppWindow, close: X, "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight, "chevron-down": ChevronDown, gear: Settings, "person-add": UserPlus, "arrow-bracket-to-left": LogOut,
  "arrow-up": ArrowUp, copy: Copy, check: Check, "cloud-download": Download, bell: Bell, "bell-slash": BellOff, image: Image,
  paperclip: Paperclip, "smiley-plus": SmilePlus, info: Info, people: Users, pencil: Pencil, file: File, folder: Folder,
  "layout-sidebar-left": PanelLeft, sun: Sun, moon: Moon, "arrows-expand": Expand, "arrows-contract": Shrink,
  "arrow-u-up-right": Reply, "list-bullets": List, eye: Eye, "eye-slash": EyeOff, pin: Pin, megaphone: Megaphone, trash: Trash2, search: Search, quote: Quote,
};
export function Icon({ name }: { name: string }) {
  const Glyph = ICONS[name] ?? Info;
  return <Glyph className="ui-icon" aria-hidden="true" focusable="false"/>;
}
export function IconButton({ icon, label, className = "", ...props }: { icon: string; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`ui-iconbtn ${className}`} aria-label={label} title={label} {...props}><Icon name={icon}/></button>;
}
export function Modal({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const el = ref.current!; const previous = document.activeElement as HTMLElement | null;
    el.showModal(); return () => { el.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={ref} className={`ui-small-dialog ${className}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <IconButton icon="close" label={`关闭${title}`} className="ui-dialog-close" onClick={onClose}/>
    <div className="ui-dialog-body"><h1 id={id}>{title}</h1>{children}</div>
  </dialog>, document.body);
}
/** Clipboard API needs a secure context; plain-HTTP LAN access (the usual Jarvy setup) falls back to execCommand. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  }
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
  document.body.append(area); area.select();
  try { return document.execCommand("copy"); } finally { area.remove(); }
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { if (state === "idle") return; const timer = setTimeout(() => setState("idle"), 1500); return () => clearTimeout(timer); }, [state]);
  const copy = async () => setState(await copyText((ref.current?.textContent ?? "").replace(/\n$/, "")) ? "copied" : "failed");
  return <figure className="ui-code-figure"><pre ref={ref}>{children}</pre>
    <IconButton icon={state === "copied" ? "check" : "copy"} label={state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制代码"} onClick={() => void copy()}/>
  </figure>;
}
// Chat text keeps single line breaks as typed (soft break -> <br>), like common chat apps.
const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];
export const Markdown = memo(function Markdown({ text, renderQuote }: { text: string; /** Partial quotes: "#quote-N" links (channel/quotes.tsx). */ renderQuote?: (index: number) => ReactNode }) {
  return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} skipHtml components={{
    // channel/mentions.ts turns "@name" into "#mention" / "#mention-me" links; they render as highlights.
    a: ({ href, children }) => href === "#mention" || href === "#mention-me"
      ? <span className="jv-mention" data-me={href === "#mention-me" || undefined}>{children}</span>
      : renderQuote && href?.startsWith("#quote-") ? renderQuote(Number(href.slice(7)))
      : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>[图片：{alt || "外部图片已隐藏"}]</span>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  }}>{text}</ReactMarkdown>;
});
