# Design system

Every screen is built from the same few values and the same few parts (A97). A change to the UI is checked against this page first; a new kind of UI extends this page (a new part, or a new step in a scale) before it is used anywhere.

- **Values** come from the scales below, as `--ui-*` variables in `web/styles/tokens.css`. Feature CSS never writes a pixel value for spacing, type, radius or shadow.
- **Parts** own their spacing and alignment. A page puts parts together; it does not restyle their insides.
- **Checks** keep it that way: `npm run check:architecture` rejects literal values where a variable is required, and the end-to-end run checks alignment across pages.

## Scales

### Spacing

Padding, margin and gap take one of nine steps, on a 4 px grid with 2 and 6 for tight places:

| Variable | px | For |
| --- | --- | --- |
| `--ui-space-2` | 2 | Hairline gaps: between stacked lines of one row, a badge from its text |
| `--ui-space-4` | 4 | Inside a control: icon to label, between icon buttons |
| `--ui-space-6` | 6 | A row's vertical padding; label to its field |
| `--ui-space-8` | 8 | A row's horizontal padding; between items in a row; an icon or avatar to its text |
| `--ui-space-12` | 12 | A list column's inset; a card's padding |
| `--ui-space-16` | 16 | A content column's inset; between fields; a panel's padding |
| `--ui-space-20` | 20 | A dialog's inset |
| `--ui-space-24` | 24 | Between sections |
| `--ui-space-32` | 32 | Around an empty state |

Two insets are named, because every column uses one of them:

- `--ui-inset-list` (12): the sidebar, the Environments list, the members and thread panes. Their header, search box and rows share this edge.
- `--ui-inset-content` (16): a chat, a page's content. Its header, transcript and composer share this edge.

### Type

Each size comes with its line height for single-line UI:

| Variable | Size / line | For |
| --- | --- | --- |
| `--ui-text-2xs` | 10 / 14 | Digits in count badges only |
| `--ui-text-xs` | 11 / 16 | Times, role tags, the rail's labels |
| `--ui-text-sm` | 12 / 16 | A row's second line, meta lines, hints under a list |
| `--ui-text-md` | 13 / 18 | Field labels, section titles, secondary text, small buttons |
| `--ui-text-base` | 14 / 20 | Body: messages, row names, inputs, buttons, menus |
| `--ui-text-lg` | 15 / 20 | A column header's title |
| `--ui-text-xl` | 17 / 24 | A dialog's page title, a Bot's name in Bot info |
| `--ui-text-display` | 22 / 28 | Empty states, the agent's page, sign-in |

The sizes follow the macOS text styles (body 13, title 15, 17 and 22), with 14 for body text as the web reads it.

Weights are the three every system font has, so they look the same on macOS, Windows and Linux: 400 for text, 500 for names (rows, tabs, buttons), 600 for titles and labels that head something (column headers, dialog titles, section titles, a message's author, badges).

Long text keeps its reading height (1.5 to 1.7) rather than a single-line one: messages, Markdown, document bodies.

Exceptions, kept where they are:

- Inputs on a phone are 16 px, so iOS does not zoom into them.
- Markdown and the document viewer have their own heading sizes in `rich-text.css` and `attachments.css`.
- Emoji glyphs, the cat and the logo are sized as pictures, not as text.

### Radius

| Variable | px | For |
| --- | --- | --- |
| `--ui-radius-xs` | 4 | Tags, inline code, focus outlines inside a row |
| `--ui-radius-sm` | 6 | Small controls inside a row: a segmented control's thumb, a row's icon button |
| `--ui-radius-md` | 8 | Controls and rows: buttons, inputs, list rows, menu items |
| `--ui-radius-lg` | 12 | Cards and grouped lists, popovers, a Bot's card |
| `--ui-radius-xl` | 16 | Dialogs and sheets |
| `--ui-radius-full` | 999 | Pills, avatars, the composer |

A radius inside another is the outer one less the padding between them, so nested corners stay parallel. shadcn's `--radius-*` are set from these, so its parts match.

### Shadow and lines

- `--ui-shadow-sm`: a raised control (a selected segment, a switch's knob).
- `--ui-shadow-md`: menus and popovers.
- Hairline outlines are borders, not shadows: `1px solid var(--ui-border-weak)` between parts, `--ui-border-default` around a control.

### Sizes

- **Controls**: `--ui-control-sm` 28 (icon buttons, small buttons), `--ui-control-md` 32 (buttons, inputs, menu and nav items), `--ui-control-lg` 36 (the search box in a list column).
- **Column headers**: `--ui-header` 52, 48 on a phone. The desktop client's title bar is this row (A96).
- **Icons**: 14 inside text, 16 in controls and rows, 20 as a row's leading icon.

## Copying

The shell does not select (A100): nothing in it can be dragged blue, and a press on it leaves no caret where typing would do
nothing. Content says otherwise for itself with `user-select: text`:

- a message, and a channel's notice and a thread's summary, which share its box (`.ui-bubble`) — the copy/quote menu
  reads its selection from there and nowhere else;
- a file's source or text;
- a Bot's log and a tool call's input;
- every field a person types in.

A value meant to be copied whole, such as a machine's public key, uses `user-select: all`.

## Parts

### Column header

The top row of every column: a chat, the sidebar, the Environments page, the members, thread, search and thread-list panes, followed threads.

- `--ui-header` high, a bottom line in `--ui-border-weak` (except the sidebar's, which has none).
- Inset `--ui-inset-content` in a content column, `--ui-inset-list` in a list column or pane; on a phone every column's is `--ui-inset-list`.
- Left: an optional back or menu button, then the title at `--ui-text-lg` / 600, on the left, then an optional muted subtitle at `--ui-text-md`. Right: icon buttons, `--ui-space-4` apart.
- A title that opens something (a channel's opens channel info) is a button in the same type, with a hover fill.
- One component, `ColumnHeader` (`components/column-header.tsx`), and one class, `.ui-column-header`, so the desktop frame (`desktop.css`) styles one thing. Its `place` is `content`, `pane` or `sidebar` (the list column of Chats and Environments, the one with no line).
- In the desktop client this row is the title bar (A96): it moves the window, its controls stay clickable, and the header at the top right keeps clear of the window's buttons (`--jv-controls`) with a short vertical line between them.

### Dialog header

The top of Settings' pages and of Bot info: the title at `--ui-text-xl` / 600, actions on the right, inset `--ui-space-20` (16 on a phone), with the close button in the corner kept clear.

### List row

One component, `ListRow` (`components/list-row.tsx`, class `.ui-row`), for the rows people pick from: channels, DMs, environments, members, Settings' navigation.

- `--ui-radius-md`, padding `--ui-space-6` × `--ui-space-8`, leading part to text `--ui-space-8`.
- Leading: a 16 px glyph column (a channel's `#` or pin), a 20 px icon in a 32 px tile (`.ui-tile`), or an avatar (32, or 36 for DMs).
- Name at `--ui-text-base` / 500 (600 when unread); second line at `--ui-text-sm` in `--ui-text-tertiary`, `--ui-space-2` below.
- Trailing: on the first line a time or state at `--ui-text-xs`, on the second a count badge; a more button shows on hover in place of the first line's end. Without hover it always shows, and the first line keeps room for it.
- Hover `--ui-fill-ghost-hover`, selected `--ui-fill-ghost-selected`.
- The chat list keeps one row height: a row with nothing on its second line is centred at the same height.
- A one-line row (Settings' navigation, the followed-threads entry) is `--ui-control-md` high with a 16 px icon.

### Grouped list

Settings-style rows inside one bordered box: Settings, Bot info, an environment's details.

- The box: `--ui-radius-lg`, `1px solid var(--ui-border-weak)`, `--ui-bg-subtle`; rows split by the same line.
- A row: padding `--ui-space-12` × `--ui-space-16`; name at `--ui-text-base` / 500, detail at `--ui-text-md` secondary; a chevron when it opens something.
- A section title above it at `--ui-text-md` / 600 secondary, `--ui-space-8` above the box; sections `--ui-space-24` apart.

### Card

A block with its own border: the notice, request cards in a chat, a followed thread, a Bot's card.

- In a page: `--ui-radius-lg`, padding `--ui-space-12`, `1px solid var(--ui-border-weak)`.
- Floating (a Bot's card, popovers): the same, on `--ui-bg-elevated` with `--ui-shadow-lg`.
- Title at `--ui-text-base` / 600, body at `--ui-text-md`.

### Field

- Label at `--ui-text-md` / 500, `--ui-space-6` above the input.
- Input `--ui-control-md` high, `--ui-radius-md`, text at `--ui-text-base`.
- Hint or error at `--ui-text-md` below, `--ui-space-4` from the input.
- Fields `--ui-space-16` apart; the form's buttons on the right at the end.
- The whole box takes the press: its padding belongs to the input, so a press anywhere in it puts the caret in (at the
  end of the text) and the pointer over it is the text pointer. The composer is such a box, buttons and all.

### Composer

- One component, `Composer` (`composer/Composer.tsx`), and one stylesheet (`styles/composer.css`) own its frame, insets and placement across channels, DMs, thread panes, full/embedded threads and the home dock. Callers pick `place` (`content`, `pane`, `wide`, `dock`) instead of restyling its internals.
- `content` (channel and DM) and `pane` (thread beside a channel) keep the same `--ui-space-16` bottom inset (and mobile safe-area inset), so side-by-side composers sit on the exact same baseline while `pane` keeps `--ui-inset-list` horizontally to match its pane header.
- One line: a pill at `--ui-radius-full`, `--ui-control-md` high, the attach and send buttons beside the text.
- More than one line: a card at `--ui-radius-lg`, the text on a row of its own, the buttons on the row under it.
- The card's text takes the box's whole inside width, `--ui-space-8` from each side, and wraps there. Whether the text
  is still one line is measured against the width a pill gives it, not the box's current width: the pill is what
  decides, so a line that only just wrapped cannot fit again in the wider card and turn it back into a pill.

### Button

- `--ui-control-md` high, `--ui-radius-md`, `--ui-text-base` / 500, padding `--ui-space-12`; small: `--ui-control-sm`, `--ui-text-md`, padding `--ui-space-8`.
- Primary for the one action a view is for; secondary for the rest; ghost for icon buttons.

### Tabs

- Underlined, for a dialog's pages (Bot info): `--ui-text-base` / 500, `--ui-space-20` apart, a 2 px line under the current one.
- Segmented, for filters in a column (followed threads, an environment's type): `--ui-control-sm` high, `--ui-radius-sm` thumb on a `--ui-radius-md` track.

## Checks

- `check:architecture` runs `scripts/check-design.mjs` to enforce shared part CSS ownership (for example, `Composer` classes may only be styled in `styles/composer.css`, and non-dock `data-place` variants may only adjust horizontal insets so side-by-side composers keep one bottom baseline).
- `check:architecture` reads `web/styles/*.css` (except `tokens.css` and `shadcn.css`) and the `className`s in `web/**/*.tsx`: a literal `px` in padding, margin, gap, font-size, line-height, border-radius or box-shadow fails, as does a Tailwind arbitrary value (`text-[11px]`). Widths and heights of pictures and layouts are not checked. Allowed: `0`; border widths (`1px solid …`); a variable inside `calc()` (`calc(-1 * var(--ui-space-4))` for a negative margin, `calc(var(--ui-control-md) + var(--ui-space-8))`).
- The end-to-end run measures every column header (same height, title on the same baseline), the list columns' rows (same left edge as the search box), and compares a shot of each page with the last approved one.
