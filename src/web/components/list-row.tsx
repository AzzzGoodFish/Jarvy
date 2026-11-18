import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Icon } from "../ui";

/** A row people pick from (A97, docs/design.md): a channel, a DM, an environment, a member, a Settings section. The
 * row owns its spacing, type and states; a list passes only what goes in it.
 *
 * - `leading`: a glyph (a channel's #), a `ui-tile` icon, or an avatar.
 * - `title` with `titleEnd` after it on the first line (a muted bell, a time, a Bot's state); `sub` with `subEnd` on
 *   the second (the last message, the unread count). With no `sub` the row is one line.
 * - `line`: a one-line row at control height with a 16 px icon (Settings' sections, the followed-threads entry).
 * - `more`: a button that shows on hover in place of `titleEnd` and opens the row's menu.
 * - `static`: a row that does nothing when pressed (a person among a channel's members) is a `div`. */
export function ListRow({ leading, title, titleEnd, sub, subEnd, trailing, active, unread, line, more, static: still, className = "", onContextMenu, ...button }: {
  leading?: ReactNode;
  title: ReactNode;
  titleEnd?: ReactNode;
  sub?: ReactNode;
  subEnd?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  unread?: boolean;
  line?: boolean;
  more?: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void };
  static?: boolean;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onContextMenu">) {
  const two = sub !== undefined;
  const body = <>
    {leading}
    <span className="ui-row-text">
      <span className="ui-row-line"><span className="ui-row-title">{title}</span>{titleEnd && <span className="ui-row-end">{titleEnd}</span>}</span>
      {two && <span className="ui-row-line ui-row-sub"><span className="ui-row-digest">{sub}</span>{subEnd}</span>}
    </span>
    {trailing}
  </>;
  const flags = { "data-active": active || undefined, "data-unread": unread || undefined, "data-line": line || undefined, "data-two": two || undefined };
  const row = still ? <div className={`ui-row ${className}`} {...flags}>{body}</div>
    : <button type="button" className={`ui-row ${className}`} aria-current={active ? "page" : undefined} {...flags} {...button}
      onContextMenu={more ? undefined : onContextMenu}>{body}</button>;
  if (!more) return row;
  return <div className="ui-row-wrap" onContextMenu={onContextMenu}>
    {row}
    <button type="button" className="ui-row-more" aria-label={more.label} title={more.label} onClick={more.onClick}><Icon name="more"/></button>
  </div>;
}
