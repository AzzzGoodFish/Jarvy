# Work environments

[Index](../index.md) · [Bot runtime](runtime.md) · [Tools and prompt](tools-and-prompt.md) · [Decisions](../decisions.md) (A50, A57)

A work environment is where a Bot's `bash`, `read`, `write` and `edit` run. The Bot itself — its Pi session, model calls and chat tools — always runs in Jarvy.

Two words, kept apart:

- **Workspace**: the Bot's own folder, `bots/<id>/`, which every Bot has and never shares; it tells people where the Bot's private, lasting files are. Its tools see `workspace/` inside it; its sessions and History sit beside that and never enter an environment.
- **Work environment**: where its tools run. A Bot's default is one of two kinds: its **sandbox**, which Jarvy makes and manages for it alone (a container; later a VM; the code calls it a `computer`), where the workspace is mounted as `/workspace`; or **the owner's computer** (`host`), where the workspace is the folder itself. **External environments** the owner adds, so far **SSH machines** (A57), are places a Bot is granted and switches to, never a default.

People read 沙箱 / "Sandbox" and 你的电脑 / "Your computer"; a Bot reads "your sandbox" and "your owner's computer". An SSH machine goes by the name the owner gave it.

## Layers

| Layer | Code | Knows |
| --- | --- | --- |
| Interface | `shared/environment.ts` (`WorkEnvironment`) | run a command with streamed output, read a file or its first bytes, write, make a directory, check a path, close |
| Execution | `infra/env/` | Pi Durable's `NodeExecutionEnv`, pi-env, the docker command line for Bots' sandboxes, and `ssh`/`ssh-keygen` for SSH machines (`ssh.ts`); nothing else imports pi-env or Pi Durable (`check-boundaries`) |
| Tools | `infra/pi/environment-tools.ts` | Pi's tool definitions with operations on the interface |
| Rules | `service/bot/environments.ts` (`BotEnvironments`), `service/bot/computers.ts` (`Computers`), `service/bot/machines.ts` (`SshMachines`) | which environment a Bot is in; the life of Bots' sandboxes; adding, checking and removing SSH machines |

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
- **An SSH machine** (`ssh`): pi-env over `ssh`, logging in with the key Jarvy made for it (below). Commands get the login's own environment.

A new Bot gets a sandbox when this machine has Docker, unless whoever creates it asks for the owner's computer (`POST /bots {environment}`, the agent's `bots.create {environment: sandbox | host}`); the owner can change the default in Bot info or the new Bot's first setup (`PUT /bots/:id/environment {home}`), which moves the Bot there too.

## In Bot info

The section has two parts:

- **Where it works**: its default, picked with a two-way switch between the sandbox and the owner's computer, and a line saying where it is now when it switched away. When the default is the sandbox, its details open below: what it is, its state, Start or Stop, and Reset. Stopping closes what the Bot left running and resetting removes what it installed, so both ask in place first (Bot info is itself a dialog).
- **External environments it may use**: one switch each, a grant: the owner's computer, shown for a Bot whose default is its sandbox, and each SSH machine by its name. Turning one off while the Bot is there sends it back to its default. Bot info says which machine a Bot is on when it switched there.

A new Bot's first setup offers the same two defaults as a list with a sentence each.

## Grants and switching

- **May use**: a Bot may be in its sandbox, its default, and what its owner granted it (`environment_grants`): the owner's computer, for a Bot whose default is its sandbox (`PUT /bots/:id/environment {hostGranted}`), and SSH machines (`PUT /bots/:id/environment {machineId, granted}`, or from the machine in Settings). A grant lasts until it is taken back; only the owner grants, not the agent Bot.
- **Switching**: `environments.list` gives the environments the Bot may use, with ids, names, the directory its tools start in, its default and a sandbox's state; `environments.switch` moves it, like `cd`, until it switches back, starting a stopped sandbox first and answering with the directory and what the Bot can do there. On the owner's computer it starts in its workspace there. Bot info shows where a Bot is when it switched away from its default.
- **Telling the Bot**: the system prompt's Workspace and Work environment sections describe the Bot's workspace and default and never change with a switch, so the prompt cache survives one; each batch ends with `<environment name directory/>`, where it is now ([envelope](envelope.md)). What the owner changes reaches the Bot as a `change` delivery ([delivery](delivery.md), A41), told once and kept in its History: a move (a new default, or taking the owner's computer back while the Bot is there) interrupts a running turn like an @, stopping its commands but not the processes it left running in the background, and starts a new one with the news; a Bot that isn't running, and a change of access alone, hear of it with their next batch.
- `bots.list {environments: true}` adds each Bot's default, current and usable environments.

## A Bot's sandbox

- **Image**: built on this machine from the Dockerfile in `infra/env/computer-image.ts` (Playwright's Ubuntu 24.04 image with its browsers, plus the matching `playwright` package found by any script, CJK fonts, git, Python with its headers, build tools and sudo; npm installs globally under the user's home), tagged `jarvy-computer:<hash>` of the Dockerfile and the owner's ids, so a change builds a new one, after which older ones no container uses are removed. One image serves every Bot and is stored once, so what most Bots need belongs in it and the rest is theirs to install. The first build pulls the base and takes minutes; its output goes to `computers/build.log`.
- **Container**: `jarvy-<data>-<bot>`, labelled with a hash of the data directory and the Bot's id. It runs `sleep infinity` with `--init` as user `bot`, which has the owner's user and group ids (so its files in the workspace are the owner's) and passwordless sudo. The Bot's `workspace/` is mounted as `/workspace`, its directory there and `bot`'s home, so its settings and caches (`~/.ssh`, `~/.gitconfig`, `~/.cache`) stay with the workspace and outlive a reset; a container from an older image has its home moved in place when Jarvy first connects to it, keeping what was installed; `computers/bin` (the pi-env daemon, kept current from the package at startup) is mounted read-only at `/opt/jarvy`.
- **Reaching it**: one pi-env connection per Bot over `docker exec -i <container> /opt/jarvy/pi-env`, carrying every request; pi-env starts it again after it is lost. If a call fails because the container stopped behind Jarvy's back, Jarvy starts it and tries once more.
- **Life**: made when the Bot gets it, in the background (`preparing`); started by the next tool call or the Start button; kept running until the owner stops it with the Stop button, since stopping closes what the Bot left running; a reset removes the container, so the next start makes a fresh one — software installed with sudo goes, `/workspace` stays; deleting the Bot removes the container. Containers keep running when Jarvy stops, so background work survives a restart. A sweep every minute learns container states and removes containers of this data directory that no Bot has.
- **States** shown in Bot info: `preparing`, `running`, `stopped`, `failed` (the start failed; the code is kept), `unavailable` (no Docker here).
- **Files from the chat** come into an environment only by `files.get`; files a Bot sends are read from its current environment, whichever it is.
- **Long command output**: Pi keeps the whole of a truncated bash output in a temporary file on this machine; for a Bot elsewhere the file is moved into its environment's temporary directory (`temp/` in its directory; on an SSH machine `~/.cache/jarvy/<bot>/`) and the result names that path. `history.read` with `to_file` and `files.get` write there too.

## SSH machines

Machines the owner adds over SSH (A57), listed in Settings → 工作环境 / Environments and granted to Bots one by one.

- **Adding**: the owner gives host, port (22), user, an optional name (default `user@host`) and start directory (default the user's home; `~/…` is under it). Jarvy scans the host's keys without logging in and shows their fingerprints to check against the machine. Then the owner lets Jarvy in one of two ways (A59):
  - **The password**: Jarvy makes an ed25519 key pair (`ssh-keygen`), logs in with the password, appends the public key to `~/.ssh/authorized_keys` (once; its comment is `jarvy-<machine id>`), and logs in again with the key to learn the system and home. When the machine refuses the key (`PubkeyAuthentication no`), Jarvy logs in with the password instead and keeps it sealed; the key stays installed for when keys are allowed. A machine that takes no passwords says so (`ssh_password_refused`) and the owner picks the other way.
  - **Adding the key themselves**: Jarvy makes the key pair and shows its public line to copy (kept in memory for an hour, under a `keyId`); the owner adds it to `authorized_keys` and Jarvy checks a login with it (`ssh_key_refused` if it isn't there).

  Either way the machine is saved only after a login works. A step that fails saves nothing, and a key Jarvy installed is taken off again.
- **Asking**: `environments.request` posts the same check as a card in a chat with the owner, who types the password there or adds the key it shows; the machine is added and granted to the Bot before the card settles. A wrong password leaves the card open. A machine already added only needs Allow; one the Bot may already use returns at once.
- **Keys**: the private key is sealed under the master key (`environment:<id>`, A52) and written to an owner-only file under `ssh/` in the data directory only while a connection is open, with a `known_hosts` file holding the accepted keys under the alias `jarvy-<id>`. The public line is read back from the private key (the OpenSSH format keeps it in the clear) and shown with a copy button in the machine's details.
- **Password logins**: a kept password is sealed too (`environment-password:<id>`). While a connection is open it sits in an owner-only file beside the key, read by an askpass helper; pi-env is given a wrapper `ssh` that puts `BatchMode=no`, password authentication and no public key before pi-env's own options (ssh keeps an option's first value). In the details, 更新密码 checks a new one with a login before keeping it, and 改用密钥 (as does Check fingerprint) tries the key: once it works the password is dropped. Jarvy reads neither `~/.ssh/config` nor `~/.ssh/known_hosts` (`-F /dev/null`), so a machine is reached exactly as it was added. `ssh/` is cleared at start.
- **Host keys**: checked strictly. A machine that presents another key is refused (`ssh_host_key_changed`); in Settings, Check fingerprint scans it again and, when the key changed, shows the new one to accept.
- **Working there**: a Bot granted a machine switches to it; the switch connects first and checks the start directory exists, else the Bot stays where it was. pi-env's daemon is deployed to the machine on first use. Changing the start directory moves Bots working there at their next call. Jarvy's files for a Bot go in `~/.cache/jarvy/<bot>/` there, never in the start directory.
- **Deleting**: removes Jarvy's line from `authorized_keys` first, logging in the way the machine is reached; when the machine can't be reached the owner may delete it anyway and remove the line by hand. Bots working there go back to their default and are told; the sealed key and password are dropped.
- **Systems**: Linux and macOS.
- **Limit**: Pi's `write` and `edit` look a path up on the machine running Jarvy before writing (to queue changes to one file). A path that exists there but can't be read by Jarvy's user, such as `/root/...` when Jarvy runs as someone else, makes them fail; `bash` still works there.
