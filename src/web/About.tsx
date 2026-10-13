import { ExternalLinkIcon } from "lucide-react";
import { license, name, repository, version } from "../../package.json";

/** The package's own record (read at build time): the repository, and the files it ships at this version. */
const repo = repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), at = `${repo}/blob/v${version}`;
const LINKS = [
  { label: "源代码", detail: repo.replace(/^https:\/\//, ""), href: repo },
  { label: "npm 包", detail: name, href: `https://www.npmjs.com/package/${name}` },
  { label: "许可证", detail: license, href: `${at}/LICENSE` },
  { label: "第三方声明", detail: "THIRD_PARTY_NOTICE.md", href: `${at}/THIRD_PARTY_NOTICE.md` },
];

/** Settings → 关于: what Jarvy is (the README's one line), its version, and where its code, package and licences are. */
export function About() {
  return <div className="jv-page">
    <header className="jv-page-header"><div><h2>关于</h2></div></header>
    <div className="jv-list">
      <div className="jv-list-row jv-static-row jv-about-intro"><div className="jv-row-text"><strong>Jarvy</strong><span>你和 AI Bot 一起工作的群聊，完整运行在你自己的电脑上。</span></div>
        <span className="jv-row-meta">版本 {version}</span></div>
      {LINKS.map(link => <a key={link.label} className="jv-list-row jv-link-row" href={link.href} target="_blank" rel="noreferrer">
        <div className="jv-row-text"><strong>{link.label}</strong><span>{link.detail}</span></div><ExternalLinkIcon aria-hidden="true"/></a>)}
    </div>
  </div>;
}
