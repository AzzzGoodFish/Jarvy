# Third-party material

## Copied or adapted code

- **shadcn/ui** — `src/web/components/ui/` holds local copies of `badge`, `button`, `card`, `dialog`, `input`, `input-group`, `label`, `scroll-area`, `select` and `textarea` from shadcn/ui (`apps/v4/registry/new-york-v4/ui/`, commit `98a1fe67b439324ddc857f47fbdce056600a4329`), adapted to local imports. © shadcn, MIT; license at `licenses/SHADCN-UI-MIT.txt`.
- **Bossmode** — `src/web/styles/login.css` adapts the login page layout of Bossmode 0.29.0 (commit `84e742f`, `web/src/styles/login.css`), now on Jarvy's own colours. The attachment preview in `src/web/files/` was reimplemented after Bossmode 0.29.1's file viewer behaviour (static HTML rendering, kinds, navigation). Apache-2.0; license at `licenses/BOSSMODE-APACHE-2.0.txt`.

Jarvy's design tokens (`src/web/styles/tokens.css`) and the remaining styles are its own. Icons are [Lucide](https://lucide.dev) (ISC, via `lucide-react`).

## References

- The provider and model settings follow the interaction of **Pi Web** (`agegr/pi-web`, MIT), studied through its frontend source and running UI. Jarvy implements the forms with its own shadcn/Radix controls and does not reuse Pi Web's configuration-file or credential storage.
- The Bot figure is ported from the project's own "Bot cat 3D study" and rendered with **three.js** 0.186.1 (MIT, © three.js authors).

## Dependencies

- Runtime: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.99.1, `hono` 4.13.11, `@hono/node-server` 2.1.3, `typebox` 1.3.27, `proper-lockfile` 4.1.2, `undici` 8.10.2 — MIT. Jarvy calls Pi's native model, tool, OAuth and refresh APIs rather than copying provider login code.
- Frontend: React, Tailwind CSS, Radix UI, Lucide React, `cn`, class-variance-authority, react-markdown, remark-gfm, remark-breaks, three.js — under their own licenses, shipped with the installed packages.
- Development only: **Agentation** (`agentation` 3.1.2, © Benji Taylor, PolyForm Shield 1.0.0) is loaded only in Vite development builds and is not part of the production build.

Jarvy is not affiliated with any of the projects above.
