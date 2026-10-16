# Work environments

[Index](../index.md) · [Bot runtime](runtime.md) · [Tools and prompt](tools-and-prompt.md) · [Decisions](../decisions.md) (A50)

A work environment is where a Bot's `bash`, `read`, `write` and `edit` run. The Bot itself — its Pi session, model calls and chat tools — always runs in Jarvy.

## Layers

| Layer | Code | Knows |
| --- | --- | --- |
| Interface | `shared/environment.ts` (`WorkEnvironment`) | run a command with streamed output, read a file or its first bytes, write, make a directory, check a path, close |
| Execution | `infra/env/` | Pi Durable's `NodeExecutionEnv`, pi-env, and the docker command line for Bots' own computers; nothing else imports pi-env or Pi Durable (`check-boundaries`) |
| Tools | `infra/pi/environment-tools.ts` | Pi's tool definitions with operations on the interface |
| Rules | `service/bot/environments.ts` (`BotEnvironments`), `service/bot/computers.ts` (`Computers`) | which environment a Bot is in; the life of Bots' own computers |

`infra/env/durable.ts` adapts any Pi Durable execution environment to the interface: results become values or thrown errors, an abort or a timeout becomes the `aborted` / `timeout:<s>` error Pi's bash tool words, and `close()` releases what it holds.

## How the tools use it

- `environmentTools(current)` builds Pi's bash, read, write and edit with their pluggable operations and registers them as custom tools under the built-in names, so they replace Pi's local ones. Schemas, output truncation, descriptions and codemode's nested calls stay Pi's.
- Every operation asks `current()` for the Bot's environment at the time of the call, so a change of environment needs no new session.
- Pi resolves a tool's paths against the run's working directory; the tools see the current environment's directory instead.
- `read` tells pictures from their first bytes (`image-kind.ts`, Pi's own rules), wherever the file is.
- A command gets the environment Pi built for it only on the owner's computer.

## Where a Bot works

Storage (v20): `environments` rows belong to a person; a Bot has a default (`home_environment_id`) and a current environment (`current_environment_id`). NULL is the owner's computer, whose row is made when first needed, so Bots from before environments stay there. `BotEnvironments.current()` reads the current one at every tool call and opens it on first use; a move closes the old one.

- **The owner's computer** (`host`): Pi Durable's `NodeExecutionEnv` in the Bot's `bots/<id>/workspace`, with the environment Pi builds for each command.
- **Its own computer** (`computer`): a Docker container only that Bot uses (below). Commands get the container's own environment variables.

A new Bot gets its own computer when this machine has Docker, unless whoever creates it asks for the owner's computer (`POST /bots {environment}`, the agent's `bots.create`); the owner can change it in Bot info or the new Bot's first setup (`PUT /bots/:id/environment {home}`). The change applies from the next tool call; the prompt's Workspace section, rebuilt every turn, describes where the Bot is.

## A Bot's own computer

- **Image**: built on this machine from the Dockerfile in `infra/env/computer-image.ts` (Playwright's Ubuntu 24.04 image with its browsers, plus the matching `playwright` package found by any script, CJK fonts, git, Python and sudo), tagged `jarvy-computer:<hash>` of the Dockerfile and the owner's ids, so a change builds a new one. The first build pulls the base and takes minutes; its output goes to `computers/build.log`.
- **Container**: `jarvy-<data>-<bot>`, labelled with a hash of the data directory and the Bot's id. It runs `sleep infinity` with `--init` as user `bot`, which has the owner's user and group ids (so its files in the workspace are the owner's) and passwordless sudo. The Bot's `workspace/` is mounted as `/workspace`, its directory there; `computers/bin` (the pi-env daemon, kept current from the package at startup) is mounted read-only at `/opt/jarvy`.
- **Reaching it**: one pi-env connection per Bot over `docker exec -i <container> /opt/jarvy/pi-env`, carrying every request; pi-env starts it again after it is lost. If a call fails because the container stopped behind Jarvy's back, Jarvy starts it and tries once more.
- **Life**: made when the Bot gets it, in the background (`preparing`); started by the next tool call or the Start button; stopped after an hour without tool calls (not during a turn) or by the Stop button; a reset removes the container, so the next start makes a fresh one — software installed with sudo goes, `/workspace` stays; deleting the Bot removes the container. Containers keep running when Jarvy stops, so background work survives a restart. A sweep every minute learns container states, stops idle computers and removes containers of this data directory that no Bot has.
- **States** shown in Bot info: `preparing`, `running`, `stopped`, `failed` (the start failed; the code is kept), `unavailable` (no Docker here).
- **Files from the chat** come into an environment only by `files.get`; files a Bot sends are read from its current environment, whichever it is.
- **Long command output**: Pi keeps the whole of a truncated bash output in a temporary file on this machine; for a Bot elsewhere the file is moved into its environment's `temp/` and the result names that path. `history.read` with `to_file` writes there too.
