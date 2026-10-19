# Work environments

[Index](../index.md) · [Bot runtime](runtime.md) · [Tools and prompt](tools-and-prompt.md) · [Decisions](../decisions.md) (A50)

A work environment is where a Bot's `bash`, `read`, `write` and `edit` run. The Bot itself — its Pi session, model calls and chat tools — always runs in Jarvy.

Two words, kept apart (fish m1034–m1042):

- **Workspace**: the Bot's own folder, `bots/<id>/`, which every Bot has and never shares; it tells people where the Bot's private, lasting files are. Its tools see `workspace/` inside it; its sessions and History sit beside that and never enter an environment.
- **Work environment**: where its tools run. A Bot's default is one of two kinds: its **sandbox**, which Jarvy makes and manages for it alone (a container; later a VM; the code calls it a `computer`), where the workspace is mounted as `/workspace`; or **the owner's computer** (`host`), where the workspace is the folder itself. **External environments** the owner adds, such as SSH hosts, will be temporary places a Bot is granted and switches to, never a default.

People read 沙箱 / "Sandbox" and 你的电脑 / "Your computer"; a Bot reads "your sandbox" and "your owner's computer".

## Layers

| Layer | Code | Knows |
| --- | --- | --- |
| Interface | `shared/environment.ts` (`WorkEnvironment`) | run a command with streamed output, read a file or its first bytes, write, make a directory, check a path, close |
| Execution | `infra/env/` | Pi Durable's `NodeExecutionEnv`, pi-env, and the docker command line for Bots' sandboxes; nothing else imports pi-env or Pi Durable (`check-boundaries`) |
| Tools | `infra/pi/environment-tools.ts` | Pi's tool definitions with operations on the interface |
| Rules | `service/bot/environments.ts` (`BotEnvironments`), `service/bot/computers.ts` (`Computers`) | which environment a Bot is in; the life of Bots' sandboxes |

`infra/env/durable.ts` adapts any Pi Durable execution environment to the interface: results become values or thrown errors, an abort or a timeout becomes the `aborted` / `timeout:<s>` error Pi's bash tool words, and `close()` releases what it holds.

## How the tools use it

- `environmentTools(current)` builds Pi's bash, read, write and edit with their pluggable operations and registers them as custom tools under the built-in names, so they replace Pi's local ones. Schemas, output truncation, descriptions and codemode's nested calls stay Pi's.
- Each call asks `current()` for the Bot's environment when it starts and keeps it to the end, so a change of environment needs no new session and an edit never reads in one place and writes in another.
- Pi resolves a tool's paths against the run's working directory; the tools see the directory of the environment the call runs in instead.
- `read` tells pictures from their first bytes (`image-kind.ts`, Pi's own rules), wherever the file is.
- A command gets the environment Pi built for it only on the owner's computer.

## Where a Bot works

Storage (v20): `environments` rows belong to a person; a Bot has a default (`home_environment_id`) and a current environment (`current_environment_id`). NULL is the owner's computer, whose row is made when first needed, so Bots from before environments stay there. `BotEnvironments.current()` reads the current one at every tool call and opens it on first use. The one a Bot leaves closes once the operations still running there end, so a switch never cuts a command short.

- **The owner's computer** (`host`): Pi Durable's `NodeExecutionEnv` in the Bot's `bots/<id>/workspace`, with the environment Pi builds for each command.
- **Its sandbox** (`computer`): a Docker container only that Bot uses (below). Commands get the container's own environment variables.

A new Bot gets a sandbox when this machine has Docker, unless whoever creates it asks for the owner's computer (`POST /bots {environment}`, the agent's `bots.create {environment: sandbox | host}`); the owner can change the default in Bot info or the new Bot's first setup (`PUT /bots/:id/environment {home}`), which moves the Bot there too.

## In Bot info

The section has two parts (fish m1046):

- **Where it works**: its default, picked with a two-way switch between the sandbox and the owner's computer, and a line saying where it is now when it switched away. When the default is the sandbox, its details open below: what it is, its state, Start or Stop, and Reset. Stopping closes what the Bot left running and resetting removes what it installed, so both ask in place first (Bot info is itself a dialog; fish m1094).
- **External environments it may use**: one switch each, a grant. So far that is the owner's computer, shown for a Bot whose default is its sandbox; SSH hosts the owner adds in Settings will join it.

A new Bot's first setup offers the same two defaults as a list with a sentence each.

## Grants and switching

- **May use**: a Bot may be in its sandbox, its default, and what its owner granted it (`environment_grants`). So far the owner's computer is the one environment to grant, for a Bot whose default is its sandbox (`PUT /bots/:id/environment {hostGranted}`). A grant lasts until it is taken back; only the owner grants, not the agent Bot.
- **Switching**: `environments.list` gives the environments the Bot may use, with ids, names, the directory its tools start in, its default and a sandbox's state; `environments.switch` moves it, like `cd`, until it switches back, starting a stopped sandbox first and answering with the directory and what the Bot can do there. On the owner's computer it starts in its workspace there. Bot info shows where a Bot is when it switched away from its default.
- **Telling the Bot**: the system prompt's Workspace and Work environment sections describe the Bot's workspace and default and never change with a switch, so the prompt cache survives one; each batch ends with `<environment name directory/>`, where it is now ([envelope](envelope.md)). What the owner changes reaches the Bot as a `change` delivery ([delivery](delivery.md), A41), told once and kept in its History: a move (a new default, or taking the owner's computer back while the Bot is there) interrupts a running turn like an @, stopping its commands but not the processes it left running in the background, and starts a new one with the news; a Bot that isn't running, and a change of access alone, hear of it with their next batch.
- `bots.list {environments: true}` adds each Bot's default, current and usable environments.

## A Bot's sandbox

- **Image**: built on this machine from the Dockerfile in `infra/env/computer-image.ts` (Playwright's Ubuntu 24.04 image with its browsers, plus the matching `playwright` package found by any script, CJK fonts, git, Python with its headers, build tools and sudo; npm installs globally under the user's home), tagged `jarvy-computer:<hash>` of the Dockerfile and the owner's ids, so a change builds a new one, after which older ones no container uses are removed. One image serves every Bot and is stored once, so what most Bots need belongs in it and the rest is theirs to install. The first build pulls the base and takes minutes; its output goes to `computers/build.log`.
- **Container**: `jarvy-<data>-<bot>`, labelled with a hash of the data directory and the Bot's id. It runs `sleep infinity` with `--init` as user `bot`, which has the owner's user and group ids (so its files in the workspace are the owner's) and passwordless sudo. The Bot's `workspace/` is mounted as `/workspace`, its directory there and `bot`'s home, so its settings and caches (`~/.ssh`, `~/.gitconfig`, `~/.cache`) stay with the workspace and outlive a reset (fish m1084–m1090); a container from an older image has its home moved in place when Jarvy first connects to it, keeping what was installed; `computers/bin` (the pi-env daemon, kept current from the package at startup) is mounted read-only at `/opt/jarvy`.
- **Reaching it**: one pi-env connection per Bot over `docker exec -i <container> /opt/jarvy/pi-env`, carrying every request; pi-env starts it again after it is lost. If a call fails because the container stopped behind Jarvy's back, Jarvy starts it and tries once more.
- **Life**: made when the Bot gets it, in the background (`preparing`); started by the next tool call or the Start button; stopped after an hour without tool calls (not during a turn) or by the Stop button; a reset removes the container, so the next start makes a fresh one — software installed with sudo goes, `/workspace` stays; deleting the Bot removes the container. Containers keep running when Jarvy stops, so background work survives a restart. A sweep every minute learns container states, stops idle sandboxes and removes containers of this data directory that no Bot has.
- **States** shown in Bot info: `preparing`, `running`, `stopped`, `failed` (the start failed; the code is kept), `unavailable` (no Docker here).
- **Files from the chat** come into an environment only by `files.get`; files a Bot sends are read from its current environment, whichever it is.
- **Long command output**: Pi keeps the whole of a truncated bash output in a temporary file on this machine; for a Bot elsewhere the file is moved into its environment's `temp/` and the result names that path. `history.read` with `to_file` writes there too.
