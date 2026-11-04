/** The pages a published port answers with itself (A74), instead of the Bot's service: they are outside the web app,
 * so they carry their words, in Chinese or English after the browser's languages. */
export type PortPage = "signin" | "stopped" | "unreachable" | "missing";
const WORDS: Record<"zh" | "en", Record<PortPage, [string, string]> & { open: string }> = {
  zh: {
    signin: ["需要登录 Jarvy", "此网页由 Jarvy 从 Bot 沙箱转发。请先在此浏览器中登录 Jarvy，然后刷新本页。"],
    stopped: ["Bot 的沙箱没有运行", "此网页所在的 Bot 沙箱已停止。请在 Jarvy 的 Bot 信息中启动沙箱，然后刷新本页。"],
    unreachable: ["网页服务没有响应", "Jarvy 正在转发此端口，但 Bot 沙箱内没有服务监听该端口，或服务仅监听 127.0.0.1。"],
    missing: ["这个链接已失效", "Jarvy 已停止转发此端口。"],
    open: "打开 Jarvy",
  },
  en: {
    signin: ["Sign in to Jarvy", "Jarvy forwards this page from a Bot's sandbox. Sign in to Jarvy in this browser, then reload this page."],
    stopped: ["The Bot's sandbox isn't running", "The sandbox this page comes from has stopped. Start it in the Bot's info in Jarvy, then reload."],
    unreachable: ["The web service isn't answering", "Jarvy forwards this port, but no service in the Bot's sandbox listens on it, or the service listens on 127.0.0.1 only."],
    missing: ["This link no longer works", "Jarvy no longer forwards this port."],
    open: "Open Jarvy",
  },
};
const escape = (text: string) => text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** The page, and its language: Chinese when the browser puts it before English. */
export function portPage(kind: PortPage, acceptLanguage: string | undefined, jarvyUrl: string | null): string {
  const languages = (acceptLanguage ?? "").toLowerCase().split(",").map(part => part.trim().slice(0, 2));
  const zh = languages.indexOf("zh"), en = languages.indexOf("en");
  const lang = zh !== -1 && (en === -1 || zh < en) ? "zh" : "en", words = WORDS[lang], [title, text] = words[kind];
  const link = jarvyUrl ? `<a href="${escape(jarvyUrl)}">${escape(words.open)}</a>` : "";
  return `<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#f6f8fa;--card:#fff;--line:#d1d9e0;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#151b23;--line:#3d444d;--accent:#4493f8}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans SC","PingFang SC",sans-serif}
main{max-width:440px;margin:24px;padding:28px 28px 24px;background:var(--card);border:1px solid var(--line);border-radius:12px}
h1{margin:0 0 8px;font-size:18px}p{margin:0 0 20px;color:var(--muted)}a{color:var(--accent);font-weight:600;text-decoration:none}
</style></head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${link}</main></body></html>`;
}
