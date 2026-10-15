# Work environments

[Index](../index.md) · [Bot runtime](runtime.md) · [Tools and prompt](tools-and-prompt.md) · [Decisions](../decisions.md) (A50)

A work environment is where a Bot's `bash`, `read`, `write` and `edit` run. The Bot itself — its Pi session, model calls and chat tools — always runs in Jarvy.

## Layers

| Layer | Code | Knows |
| --- | --- | --- |
| Interface | `shared/environment.ts` (`WorkEnvironment`) | run a command with streamed output, read a file or its first bytes, write, make a directory, check a path, close |
| Execution | `infra/env/` | Pi Durable's `NodeExecutionEnv` and pi-env; nothing else imports them (`check-boundaries`) |
| Tools | `infra/pi/environment-tools.ts` | Pi's tool definitions with operations on the interface |
| Rules | `service/bot/environments.ts` (`BotEnvironments`) | which environment a Bot is in |

`infra/env/durable.ts` adapts any Pi Durable execution environment to the interface: results become values or thrown errors, an abort or a timeout becomes the `aborted` / `timeout:<s>` error Pi's bash tool words, and `close()` releases what it holds.

## How the tools use it

- `environmentTools(current)` builds Pi's bash, read, write and edit with their pluggable operations and registers them as custom tools under the built-in names, so they replace Pi's local ones. Schemas, output truncation, descriptions and codemode's nested calls stay Pi's.
- Every operation asks `current()` for the Bot's environment at the time of the call, so a change of environment needs no new session.
- Pi resolves a tool's paths against the run's working directory; the tools see the current environment's directory instead.
- `read` tells pictures from their first bytes (`image-kind.ts`, Pi's own rules), wherever the file is.
- A command gets the environment Pi built for it only on the owner's computer.

## Environments

- **The owner's computer** (`host`): Pi Durable's `NodeExecutionEnv` in the Bot's `bots/<id>/workspace`. Every Bot works here.
- `BotEnvironments` opens a Bot's environment on first use, closes it when the Bot is deleted, and closes all of them when Jarvy stops.
