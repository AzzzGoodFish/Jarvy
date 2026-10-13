import { ExternalLinkIcon } from "lucide-react";
import { license, name, repository, version } from "../../package.json";
import { t } from "./i18n";

/** The package's own record (read at build time): the repository, and the files it ships at this version. */
const repo = repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), at = `${repo}/blob/v${version}`;
const LINKS = [
  { label: "about.source", detail: repo.replace(/^https:\/\//, ""), href: repo },
  { label: "about.package", detail: name, href: `https://www.npmjs.com/package/${name}` },
  { label: "about.license", detail: license, href: `${at}/LICENSE` },
  { label: "about.notices", detail: "THIRD_PARTY_NOTICE.md", href: `${at}/THIRD_PARTY_NOTICE.md` },
] as const;

/** Settings → About: what Jarvy is (the README's one line), its version, and where its code, package and licences are. */
export function About() {
  return <div className="jv-page">
    <header className="jv-page-header"><div><h2>{t("settings.about")}</h2></div></header>
    <div className="jv-list">
      <div className="jv-list-row jv-static-row jv-about-intro"><div className="jv-row-text"><strong>Jarvy</strong><span>{t("about.tagline")}</span></div>
        <span className="jv-row-meta">{t("about.version", { version })}</span></div>
      {LINKS.map(link => <a key={link.label} className="jv-list-row jv-link-row" href={link.href} target="_blank" rel="noreferrer">
        <div className="jv-row-text"><strong>{t(link.label)}</strong><span>{link.detail}</span></div><ExternalLinkIcon aria-hidden="true"/></a>)}
    </div>
  </div>;
}
