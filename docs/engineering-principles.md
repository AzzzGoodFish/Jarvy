# Engineering principles

[Index](index.md)

These ten rules apply to design, implementation and review.

1. **Architecture and domain first.** Plan towards the ideal architecture: business goals, domain boundaries, module responsibilities, dependency direction and data flow are settled before coding. Do not trade the overall design for short-term convenience. The design is complete; the implementation is restrained — no speculative abstraction. Abstract when a second real use appears; a single case is written directly.
2. **Clean modules.** High cohesion, low coupling, small stable interfaces that hide internal complexity. Split by single responsibility. No file over 500 lines; near the limit, rethink the module boundary first.
3. **Clear boundaries and data flow.** Protocol, domain, persistence and view models do not leak into each other. Data is validated and converted at each boundary; no mutable state shared across layers.
4. **Security and isolation by default.** Design for many users: explicit authentication, authorisation and data isolation, least privilege, every external input untrusted. Secrets never go into code, logs or responses.
5. **Built for concurrency and failure.** Consider idempotency, races, transaction boundaries, timeouts, cancellation, retries, back-pressure and resource release. Never hide problems behind unbounded retries, swallowed errors or implicit shared state.
6. **A complete frontend experience.** Control rendering cost, async state and concurrent requests; keep the UI structure clear. Every flow covers loading, empty, error, retry, feedback and accessibility.
7. **Reuse stable business meaning.** Prefer existing modules and capabilities, but do not abstract code just because it looks alike; if duplication is right, say why in a comment. Before adding a dependency, check what the project already has — read its docs and types instead of assuming a feature is missing. If one is needed, choose a mature, maintained library.
8. **Leave context for future maintainers.** Non-obvious decisions, compatibility constraints, known defects and temporary measures record the reason, scope, risk and removal condition. Key decisions go to the ADR log. No TODO without context.
9. **Verifiable, observable, reversible.** Behaviour can be checked, runtime state can be observed, failures can be located. Errors and logs keep diagnostic context without leaking secrets.
10. **Delete rather than stay compatible.** Internal refactors delete the old path: no compatibility layers, deprecated shims or dual writes. External contracts (`/api/*`, data migrations) are judged on their own as obligations, not as a reason to keep old code.

## In Jarvy

- Read the [domain](architecture/domain.md) doc and the topic you are changing before writing code. Do not build plugin frameworks for features nobody needs yet.
- Single-user is the current deployment, not a limit of the domain: identity comes from authentication or the bound Bot, chat access is checked through membership, and credentials belong to their owner's connection.
- Browser DTOs, domain objects, SQLite rows and Pi types are converted at their boundaries; Pi types stay in `infra/pi`.
- Use Pi's defaults for model requests, retries, compaction and cancellation. A new boundary is discussed first with its real trigger, what the user sees and the trade-offs; a temporary 503 retry is not the same thing as replaying a batch that already sent messages or wrote files.
- A Bot workspace is an ordinary folder, not an OS sandbox, and is never described as one.
- Schema changes are versioned migrations; a downgrade means restoring a backup with a matching build.

## Checks

- `npm run build`: server and web type checks, the layer check (`npm run check:architecture`, which also enforces the 500-line limit on server files) and the Vite build.
- Real flows in an isolated data directory; UI changes also checked in a browser (light, dark, 390 px).
- Schema changes: migrate a copy of an existing database and restart, not only a fresh one.
