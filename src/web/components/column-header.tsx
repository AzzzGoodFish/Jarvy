import type { ButtonHTMLAttributes, ReactNode } from "react";

/** One column's top row (A97, docs/design.md): a chat's, the sidebar's, a list pane's, a page's. Fixed height, a
 * bottom line, the column's own side inset, and the title in one style everywhere. In the desktop client this row is
 * the window's title bar (A96, styles/desktop.css): it moves the window, and the one at the window's top right keeps
 * clear of its buttons.
 *
 * `place` picks the inset: `content` for a chat or a page, `pane` for a side pane, `sidebar` for a page's list column
 * (no line under it). The title is a `strong` unless
 * `as` says otherwise (a chat's title opens channel info, a page's is its `h2`). `sub` is a muted line beside it, and
 * `actions` sit on the right. */
export function ColumnHeader({ place, as: Title = "strong", title, sub, leading, actions, className = "", titleProps }: {
  place: "content" | "pane" | "sidebar";
  as?: "strong" | "h2" | "button";
  /** Left out when a crumb stands in for it (a full-width thread's `# channel`). */
  title?: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  /** Right-hand buttons; they keep their own class (a row of them in `ui-column-actions`, say). */
  actions?: ReactNode;
  className?: string;
  /** A title that does something (a chat's opens channel info) is a button: its label and pressed state go here. */
  titleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const heading = Title === "button"
    ? <button type="button" className="ui-column-title" {...titleProps}>{title}</button>
    : <Title className="ui-column-title">{title}</Title>;
  return <header className={`ui-column-header ${className}`} data-place={place}>
    {leading}
    {title !== undefined && heading}
    {sub && <span className="ui-column-sub">{sub}</span>}
    <span className="ui-spacer"/>
    {actions || null}
  </header>;
}
