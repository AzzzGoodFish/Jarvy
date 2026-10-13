# Bot runtime

[Index](../index.md) · [Delivery](delivery.md) · [Models](models.md) · [Storage](storage.md)

## Lifecycle

- Bots run on the Pi coding-agent SDK (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, pinned to 0.99.1). Jarvy does not rebuild the session or tool loop.
- `jarvy run` starts the server only; no Bot session is created at startup (A11).
- A new Bot opens its DM and asks for a model, then waits for the first message. It does not greet.
- A Bot starts when something is delivered to it. Each Bot always has exactly one logical session; repeated wake-ups never create a second instance.
- Stopping a Bot or restarting the server deletes no chat, workspace or session file. After a restart only Bots with pending deliveries are woken.

## Session setup (`infra/pi/session.ts`)

1. **Host.** One process owns the data directory (a lock file). Load the Bot, its owner, its model selection and pending deliveries. Without a usable model or credential, deliveries stay pending.
2. **Directories.** `bots/<id>/workspace` (with `temp/`) is the `cwd`; `bots/<id>/agent/pi` is the agent directory. The process-wide `PI_CODING_AGENT_DIR` is never changed.
3. **One session file.** The first run registers `sessions/<timestamp>.jsonl` in SQLite; later runs open exactly that file with `SessionManager.open(file, sessionsDir, workspacePath)`. No "most recent file" guessing.
4. **Model and auth.** Build one model and its connection's credential in memory and pass `modelRuntime` explicitly; host `auth.json` / `models.json` are not loaded ([models](models.md)).
5. **Settings.** `SettingsManager.inMemory({ httpIdleTimeoutMs: 900_000 })`; everything else, including retries and compaction, is Pi's default. Before that, `infra/pi/http.ts` installs the same global undici dispatcher Pi's CLI uses, with 900 s header and body timeouts (A40).
6. **Resources and tools.** A controlled resource loader: no discovery of host extensions, skills, context files or prompt templates. It loads the `chat` tool, the codemode extension and the compiled system prompt. Tools: `bash`, `read`, `edit`, `write`, `chat`, `codemode`.
7. **Create.** `createAgentSession` gets explicit `cwd`, agent directory, session manager, model runtime, model, thinking level, settings, resource loader and tools. Resource errors and the active tool list are checked.
8. **Subscribe, then prompt.** Events are subscribed before the first prompt. State changes and queue handling happen in `AgentRuntime`, never by prompting from inside an event callback. The same subscription feeds the live turn ([live.md](live.md)) through `infra/pi/live.ts`.
9. **Shutdown.** Stop taking new work, cancel or wait for the current prompt, unsubscribe and dispose. Pending deliveries stay.

## States and turn boundaries

Bot state is **stop / idle / running**. While running, activity is `reasoning`, `texting`, `tool_calling` or `asking` (waiting on a question card), or null while waiting for the model.

- The next prompt waits for `agent_settled` **and** the previous prompt promise. `agent_end` is not enough (Pi may retry or continue), nor is `tool_execution_end`.
- A prompt can fail before `agent_start`; the caller's `catch` / `finally` closes it out.
- Interrupting calls Pi's `session.abort()`; Pi cancels the request, retries and compaction.
- A turn ends as **interrupted** when Pi's run signal was aborted, otherwise as **failed** with Pi's error message, shown as 「模型请求失败：<reason>」 (A31). History keeps Pi's original record.
- `getContextUsage()` may be unknown; it is never shown as 0 %.
- Compaction start and end (tokens before and after, or the failure) are logged.
- While a turn runs, its steps are kept in memory and sent to the Bot's DM page ([the live turn](live.md), A47).

## Switching model or thinking level

```text
user picks a connection / model / thinking level
→ serialised with start, stop and other switches (not with the running turn)
→ prepare the model and credential → await session.setModel(model, { persist: false }) / setThinkingLevel
→ on success, save the selection and return; a running turn uses it from its next model request
```

Pi reads the model and thinking level before every request and resolves the API key when a request starts, so a request in flight is never affected (A28). The session lock covers both switching and the pump's session setup. If a switch fails mid-turn the previous credential is restored and the turn goes on with the old model; the error goes back to the caller. A run's input snapshot is the selection at claim time; each History record has the model actually used.

No new session, no "reply OK" probe, no optimistic display. `setModel` is asynchronous and can partly apply, so failures are reconciled against the session's actual state. Two connections of the same provider and model ID still switch correctly: the connection is recorded in SQLite, not in Pi's JSONL.
