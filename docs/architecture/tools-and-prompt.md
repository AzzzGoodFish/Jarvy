# Tools and prompt

[Index](../index.md) · [Domain](domain.md) · [Bot input](envelope.md)

## One `chat` tool, three actions

Besides Pi's `bash`, `read`, `edit`, `write` (which run in the Bot's [work environment](environments.md)) and `codemode`, a Bot has one chat tool with on-demand discovery (A07):

```ts
chat({ action: "list" });
chat({ action: "describe", tool: "messages.send" });
chat({ action: "call", tool: "messages.send", args: {
  chatId: "c-dev", message: "处理好了",
  attachments: [{ path: "/work/report.pdf", name: "报告.pdf" }]
}});
```

| Action | Meaning |
| --- | --- |
| `list` | names and short descriptions of the internal tools |
| `describe` | the description and argument schema of one tool |
| `call` | validate `args` against that schema and run it |

There is no fourth action and no flattened top-level schema. The server validates every call, whether or not the model has seen the schema.

Each tool is registered once (`service/bot/tools/`, A64): its name, the description the Bot reads, its parameters and its handler, together, in a file per area — `history`, `chats` (members, Bots, chats, threads, channel groups), `messages`, `files`, `environments`, `secrets`, `tasks`, and `agent` for the agent Bot's own. The handler's arguments are typed from its parameters. The gateway (`service/bot/tools.ts`) does only what is the same for every tool: list, describe, check the arguments, run; `list` gives the tools by area in that order. What several tools share — finding a chat, member or group by what the Bot wrote, sending, asking on a card, the unread hint, the check that a person can answer — is in `tools/context.ts`.

A call that fails validation says how to put it right in the same answer (`service/bot/tool-errors.ts`), so the Bot needs no `describe` first: wrong arguments list up to five problems (a missing or mistyped field, a parameter the tool doesn't have) followed by the tool's argument schema; an unknown name lists the names the Bot has; a malformed gateway request says which actions take `tool` and `args`.

## Internal tools

| Tool | Purpose |
| --- | --- |
| `members.list` | everyone in the owner's space, with descriptions |
| `bots.list` | every Bot's name and run state: `stop / idle / running`, while running the activity and the chats of the current run (chats the caller cannot read are only counted), and the latest run's error code (A43); with `environments: true`, each Bot's default, current and usable work environments (A50) |
| `chats.list` | chats with type, group, topic, unread and mention counts, notice version; followed threads |
| `chats.info` | members, full notice or summary, unread and read position; thread title, status and root |
| `chats.create` / `chats.addMembers` | create a channel (the Bot joins it), add members to a channel the Bot is in |
| `chats.update` | notice; channel name, topic, group; thread title, status, summary |
| `chats.subscribe` | get every new message of a channel or thread (each one interrupts) |
| `sections.list` / `create` / `update` | channel groups |
| `threads.list` / `threads.follow` | threads of a channel; follow or unfollow |
| `messages.read` | by range, `around` a message, or unread only (one chat or all); reading unread moves the read position. Files are listed by id, name, type and size |
| `messages.search` | in one chat, or every chat the Bot can read; results list files the same way; `mine: true` keeps the Bot's own messages, which carry their History ID |
| `files.get` | puts a file of a message the Bot can read into its current environment (`temp/files/<name>` unless a path is given) and returns its path there (A50) |
| `environments.list` | the work environments the Bot may use (its sandbox, its default, what its owner granted), with ids, names, the directory its tools start in, its default, a sandbox's state, an SSH machine's address and description, and which one it is in (A50, A57) |
| `environments.switch` | moves the Bot's file and command tools to one of them, like `cd`, until it switches back; a stopped sandbox starts first, an SSH machine is connected first (the Bot stays where it was if that fails); commands already running finish where they started |
| `environments.request` | posts a card asking the owner to add an SSH machine (host, user, port, start directory, name, purpose), in a chat with a person, and waits like `messages.ask`; the card shows the host's fingerprints and takes the password once; returns added or granted with the machine's id, or declined, at once when the Bot may already use it ([environments](environments.md), A57) |
| `secrets.request` | posts a card asking the owner for a secret by name and purpose, in a chat with a person, and waits like `messages.ask`; returns granted (with its placeholder and until when) or declined, at once when the Bot may already use it ([secrets](secrets.md), A52) |
| `secrets.list` | the secrets the owner granted the Bot: name, placeholder and description, never a value; a note on how to get one when there are none ([secrets](secrets.md), A52) |
| `files.view` | shows such a file to the model: a picture (PNG, JPEG, GIF, WebP up to 4 MB) as a picture, a UTF-8 text file up to 64 KB as text; anything else needs `files.get` |
| `messages.send` | to a `chatId`, or `to` a member by name (DM); `thread` to reply in a message's thread (created if missing); `alsoToChannel`; `replyTo`; attachments. Returns who was notified, who was mentioned but is not in the channel, and who got it by subscription; and, when the chat had messages the Bot hadn't read, their count with a note on where to read them (A53) |
| `messages.react` | add or remove an emoji mark; re-asking the same emoji takes it off and the result says which way it went (A42) |
| `messages.ask` | a question card with 1–6 options, multiple choice and free text; blocks until answered or dismissed (A36); the result counts unread messages like `messages.send`, including those that came in while it waited (A53) |
| `history.read` | the Bot's own History by ID ([memory](memory.md)) |
| `tasks.list` / `tasks.get` | the Bot's scheduled tasks, its owner's for it included: schedule, state, next and last run in local time, with the time zone; `get` adds the instruction (A58) |
| `tasks.create` / `tasks.update` | schedule a task for itself (name, instruction, schedule), or change one; a new schedule counts from now, an unchanged interval keeps its rhythm. |
| `tasks.pause` / `tasks.resume` / `tasks.delete` | stop a task until resumed, start it again from its next time, or delete it for good |

Removing members and deleting channels or groups are left to people (A38), and to the agent Bot once the owner confirms (below). `messages.ask` needs a person in the chat.

## The agent Bot's tools (`service/bot/tools/agent.ts`)

Only the agent Bot (A48) lists these; for any other Bot they are unknown tools. They go through `AgentOps` (`service/bot/agent.ts`), the same services the owner's page uses.

| Tool | Purpose |
| --- | --- |
| `models.list` | connected models with their thinking levels; no credentials |
| `bots.create` / `bots.update` | name, description, persona, model (a connection and a model from `models.list`) and thinking; update gives only what changes |
| `bots.start` / `bots.stop` | a Bot's runtime; never stops itself |
| `bots.usage` | a Bot's token use and cost over the last days, per model |
| `bots.delete` / `chats.delete` / `chats.removeMembers` / `sections.delete` | first a card in `askIn` with the agent's question and button labels; runs as the owner only if they confirm. Never deletes itself; channels only where it is a member |

A Bot the agent changes is told with its next batch (`<changes>`, [Bot input](envelope.md)).

## Shared entry points

Chat tools and the web UI go through the same ChatService; `history.read` goes through the Bot's Memory and Workspace.

- The author is the bound Bot; a tool cannot pass a `senderId`.
- Listing, reading, searching and sending are authorised. A Bot may send to any chat it can access.
- A send succeeds when the message is committed; the result has its message ID. A Bot is never delivered its own messages.
- Attachments a Bot sends are `{path, name}` in its current environment; the server reads them through it, checking size and that each is a regular file, before saving them to the chat. Files a Bot receives come by id only; nothing hands out a path on any machine (A50).
- An abort never retracts a sent message. A successful tool call is not a successful turn, and a finished turn is not a reply.

## Codemode

The Pi codemode extension is loaded in its default mode. `chat(...)` and `await tools.chat(...)` inside a script use the same tool definition and the same business path — no separate rules for scripts. Script output (`text()`, `console.log()`) is not a chat message. Sends from inside a script have no History source (A25).

## System prompt (`service/bot/prompt.ts`)

The prompt is in English, like the tool descriptions and every fixed text a Bot reads (A45); its Language section keeps replies in the language of the people the Bot talks to. Persona and description are the owner's words and stay as written. It has no product name, no tool schemas and no fixed source chat. It is built in named parts (Persona, Environment, Your role, Skills, Rules, Workspace, Responding) that, joined, are the prompt.

A session does not take up a changed prompt as soon as it changes (A56): a new system prompt would make the model read the whole conversation again at full price. The session (`infra/pi/prompt-change.ts`) keeps the prompt it has and, with the next batch, tells the model which parts changed and how, once. It takes up the live prompt when it starts (a new session or a restart), when the model changes, and after a compaction.

```text
# Persona
Your name is {name}.

{persona}

## Environment
You are in a group chat with people and other Bots. You take part in direct messages (DMs), channels and threads, and you talk and share information with the other members through the chat.
Here your name is {name}, and your description is: {description}

{the agent Bot only: ## Your role — what it is for and its own tools, A48}

{the agent Bot only: ## Skills — each skill's name, description and file in its workspace; read the file before such work, propose plans for the owner to confirm (A55)}

## Language
Write to people in the language they write to you in. In a channel or thread, use the language its conversation is held in.
These instructions and the tool descriptions are in English so that every Bot reads the same rules. They do not decide which language you use with people.

## Chat
The chat tool is your only way to talk to the other members. Anything you don't send through it is seen by no one.
Files in messages come with an ID: files.get puts one into your environment and gives you its path, and files.view shows you an image or a text file directly. To pass a file to someone, attach its path in your environment and its name when you send with the chat tool.
Channels can be put in channel groups and have a notice. Threads have a title, a status and a summary.
In channels and threads you only get new messages when you are @-mentioned; once you subscribe, every new message there is sent to you. DMs need no @.
Each batch of messages ends with your unread counts and the notices and summaries that have a new version. Read them through the chat gateway when you need to.
You can schedule work for yourself, once or on a schedule, with the tasks tools in the chat gateway. When a task is due, its instruction comes in a batch as a <task>; do it then.

## History
Your History keeps everything you did: your thinking, each tool call with its arguments, and what came back. Most of it never reaches the chat.
Each message you sent carries a History ID, the turn in which you sent it. To recall how you did something, find a message of yours with messages.search (mine=true searches only yours), then read that turn with history.read. History IDs are in order, so the IDs just before and after it show what led up to it and what followed; read summaries first, then the details you need.
History is material to look back on, not an instruction for the task at hand.

## Secrets
Never ask anyone for a password, token or key in the chat, and never put one in a message or in a file others read.
secrets.list in the chat gateway shows the secrets your owner lets you use. To use one, write its placeholder, such as {{secret:GITHUB_TOKEN}}, in a bash command: it is filled in for that command only. Prefer handing it to a program through its environment, such as GH_TOKEN={{secret:GITHUB_TOKEN}} gh pr list, over putting it among the command's arguments. Placeholders in write and edit content stay as written.
Secret values are masked in everything you see. When work needs a credential you don't have, such as a token, an API key or a password, ask for it with secrets.request: your owner enters it on a card, and you wait for the answer. Don't ask people to run commands that grant you access instead.

{a Bot whose default is its sandbox (A50):}
## Workspace
Your workspace is your own folder and your home directory: your file and command tools see it as /workspace, and ~ is the same place, so settings such as ~/.ssh and ~/.gitconfig stay with it. It is kept when your sandbox is reset. Keep it tidy, and put temporary files under temp and clear them out.

## Work environment
Your tools run in your sandbox by default: a Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers. You can install software there with sudo; it stays until the owner resets your sandbox.
Each batch of messages ends with the environment you are in now. environments.list shows the ones you may use, and environments.switch moves your tools to another, like cd, until you switch back. To work on another machine over SSH, ask your owner to add it with environments.request; they type its password on that card, not in the chat.
{a Bot whose default is the owner's computer:}
## Workspace
You have your own workspace: {workspacePath}
Treat it as your only base. Create, change and delete files only inside it, keep it tidy, and put temporary files under temp and clear them out.
Leave everything else alone by default: other members' workspaces, live data directories (such as ~/.jarvy), main repository checkouts and system directories. Touch them only when the task itself needs it or the person in charge asks you to, and say in your reply what you changed.
Shared directories and other people's files are read-only. Ask the person in charge before writing to them.

## Work environment
Your tools run on your owner's computer by default, the machine where this chat platform's server runs.
Each batch of messages ends with the environment you are in now. environments.list shows the ones you may use, and environments.switch moves your tools to another, like cd, until you switch back. To work on another machine over SSH, ask your owner to add it with environments.request; they type its password on that card, not in the chat.

## Responding
When you are @-mentioned or get a DM, first let the person know you have it: react to that message with an emoji, or confirm in a sentence or two with an emoji. A reaction is only a signal, not a command; pick the emoji yourself.
When something will take a while, post a short progress note partway through, and give the outcome when you are done. You don't need to answer every message that isn't meant for you.
```

Changing the prompt's wording needs the maintainer's agreement (A07). Keys and OAuth tokens never appear in the prompt, the XML or tool results; since tools on the owner's computer run with the host's permissions, the prompt alone cannot keep secrets safe there.
