# Changelog

All notable changes to Jarvy. Versions follow [semantic versioning](https://semver.org/) as used before 1.0: a patch release only fixes bugs; a minor release adds features or upgrades the database.

## 0.14.0 — 2026-11-13

The database upgrades to v31 on first start: every existing channel gets the owner as its creator and no admins. Going back to 0.13.0 needs the database from before the upgrade. Nothing else to do: no new dependency, and every sandbox stays as it was.

### Added

- **A rail, and the agent Bot's page.** A narrow rail left of the sidebar holds the agent Bot's cat, 会话, 环境 and the account menu, which moved there from the sidebar's foot; 会话 shows a dot while something waits in another chat. On a phone it is a tab bar at the bottom, and the chat list fills the screen. The cat opens the agent Bot's page: the cat large with its name, and while it works one line beside it, as in its DM. Marks over its head stay until dealt with — a red 「!」 and a dizzy face for a failed run, 「?」 for a question, a gold 「!」 for an unread reply — and a click on one deals with it. Under the cat is a light chat: the DM's own messages and composer, about two messages high, with files, quotes, question cards, paste and drop; ↗ opens the full DM.
- **An Environments page.** 环境 on the rail lists every place Bots work: the SSH machines, then each Bot's sandbox, one row each with its kind, a sandbox's state and the Bots working there now. The one picked shows on the right: a sandbox as Bot info shows it, with its ports; a machine with its details, the Bots it is granted to, and delete; or the form to add one. Settings › 工作环境 moved here, and Bot info's 添加机器 opens it.
- **Bot info › 授权.** The secrets and SSH machines a Bot may use, each with its purpose or address: ✕ takes one back, and a search adds more; 仅限本次 marks a grant for one run. With nothing kept yet, it offers to add a secret or a machine. The machine switches moved here from 环境.
- **A Bot's card from its avatar.** A Bot's avatar in a channel, a thread or a DM opens a card beside it: avatar, name and description, whether it runs and what it is doing, where its tools run (沙箱 or the machine's name) and its model, with 发消息 (its DM) and Bot 信息 (the full page). It closes on either, on Esc, on a press elsewhere and when the chat scrolls, and it stays inside the window: on a phone it opens under the avatar, or over it when there is no room below. People's avatars don't open anything.
- **Channel creators and admins.** A channel's name, topic, group and notice can be changed by the owner, its creator and its admins; a thread's title, status and summary also by whoever takes part in it (its root's author, and anyone who replied or was @-mentioned there). Only the owner makes admins, in a channel's member list, and only Bots can be admins. Bots see who created a channel and who its admins are, and a change they may not make says who may.
- **Antigravity as a model provider.** Settings › 模型 › 添加 Provider lists Google Antigravity under 订阅服务. Sign in with a Google account: on the same machine the browser comes back by itself, from another device paste the address it lands on. The account's own models are listed (Gemini, and Claude and GPT-OSS where the account has them), each with the thinking levels the service has for it, such as low to xhigh for Gemini 4 Hydrogen, and Bots call tools on all of them. Usage is priced at the rate the model's maker charges on its own API (Google's for Gemini, Anthropic's for Claude, from the same catalog as other providers), so it compares with other connections; the subscription itself is paid by quota. A used-up quota says when it resets. One line above the sign-in buttons warns that using Antigravity through a third-party app may break Google's terms and get the account suspended.

### Changed

- **A Bot's activity reads as what it was given.** On Bot info › 活动, each input — a message, a task come due, a notice of new messages — is a card on the left saying who wrote where, with 「等 N 条」 when more came with it; the Bot's own steps stay on the right. Opening one reads the batch back as the page shows it: messages with their layout and files, tasks, reactions, setting changes and followed threads, then what the Bot hadn't read and where its tools ran (沙箱 or the machine's name, and 「当时文件和命令工具不可用」 where they couldn't run). 原始文本 and 原始 JSON show it as the Bot got it. What a Bot reads with `history.read` is unchanged.
- **Bots see every secret and machine.** `secrets.list` and `environments.list` list all of the owner's, each saying whether the Bot may use it. A placeholder for a secret it may not use isn't filled in and a switch to such a machine is refused, both naming the request tool; asking for a secret or machine the owner already keeps only needs 允许.
- **Sandbox usage against its limits.** Bot info shows memory and CPU as "used / limit" with bars (or "/ 本机 …" without a limit), and keeps them in view while limits change. A VM sandbox's are read inside the VM, with its Docker disk as a third row, and what it takes of this machine on hover or a tap.
- **Port rows open in place.** Bot info's ports and the Environments page list each port as a row, like Settings › 密钥, that opens below itself with its address, host port and actions.
- **The DM's cat has acts of its own.** At rest it hops, spins, sways, flicks an ear, tilts its head, looks around, stretches, and dozes after two and a half minutes; its ears go up when you send a message, it winds up when a turn starts, celebrates when one completes, reacts to a click, and is carried and put down. Never the same act twice in a row, and none while it works, with reduced motion or on a hidden page.
- **Still avatars without a GPU.** Where the browser would draw WebGL on the CPU (no GPU, hardware acceleration off, a blocked driver, a remote desktop), the cats show as still avatars in the same place, with the mood, the sleeping face and the marks. A live figure there kept several cores busy.
- **The switch's knob stands out in the dark theme.** It has a colour of its own, light grey in the dark theme and white in the light one; it was the colour of the surface behind it.
- **API**:
  - A channel carries `createdBy` and `adminIds`; `PUT /api/chats/:id/members/:memberId/admin {admin}` makes a Bot one of its admins or not (owner only).
  - In `GET /api/bots/:id/history`, an input record carries `input`: the first thing its batch says, how many things, and the chat and person it names. `GET /api/bots/:id/history/:recordId` carries the whole batch parsed as `input`.
  - `GET /api/bots/:id/computer/resources` gives a VM's `disk` (used and size of its Docker disk) and `host` (the memory and disk it takes of this machine).

### Fixed

- A word still being typed with an input method no longer submits on Enter in a channel's name and topic, the member search, the emoji search, the OAuth code box and the secrets' grant search, as already in the composer.
- Going to a message from a tag's card scrolls there, also in a thread pane; going to a message older than what was loaded shows it with everything after it, instead of only the page ending at it.
- An open thread, or a DM between two Bots, shows the replies posted while the page was disconnected, after Jarvy restarted or the changes since could no longer be resumed.
- A VM sandbox gives back the disk space Docker frees: its Docker disk is now mounted with discard and trimmed after each start, VMs made before included. One had grown to 56 GB while Docker used 18 GB.

## 0.13.0 — 2026-11-07

No database change: the schema stays v30, and upgrading from 0.12.2 needs nothing else. Every sandbox stays a container; a VM sandbox needs Kata Containers and KVM on this machine, which the agent Bot's setup guide explains.

### Added

- **VM sandboxes with Docker inside.** A container shares this machine's kernel, so Docker can't run in one without `--privileged`, which sandboxes never get. Bot info › 环境 › 类型 can now make a Bot's sandbox a small VM instead, run by Kata Containers from the same image, with Docker Engine and Docker Compose inside: the Bot runs `docker` and `docker compose` with its own tools, without sudo. Switching asks first and works as a reset: the workspace is kept, what was installed in the sandbox isn't. Docker's data lives on a disk of the VM's own (64 GB, allocated as it fills, under `computers/disks/`), which goes with a reset, a switch back or the Bot. A VM has 4 GB and 2 CPUs unless set otherwise: the Resource limits row becomes 虚拟机大小, and a change takes effect at the next start, with 现在重启 offered at once. Like a container, a VM can't reach other sandboxes, and a port that a container inside it publishes can be forwarded with `ports.publish`. Where VMs can't run, 虚拟机 can't be chosen and Bot info says why: Kata isn't installed, there is no KVM, another hypervisor such as VirtualBox holds it, or a trial VM failed; 重新检查 looks again.

### Changed

- **Docker that can't be used says why.** Bot info › 环境 now says in one sentence whether Docker isn't installed, its service isn't running, Jarvy may not use it, or it fails otherwise, and what that stops: without a sandbox, a Bot can't read or write files or run commands. Jarvy looks again every 30 seconds, so sandboxes start once Docker is fixed, without restarting Jarvy (joining the docker group still needs a new login and a restart). Bots see the problem when they list or switch environments, in a failing tool and in their batches, and on first setup the agent Bot offers to help.
- **The agent Bot has a setup guide.** A skill on getting Jarvy ready: model connections, Docker on each system (and what joining the docker group grants), reaching Jarvy from phones and other devices with its certificate, adding SSH machines, secrets, and VM sandboxes.
- **Skills are read with `skills.read`.** The agent Bot reads a skill when a task matches it, instead of keeping copies in its workspace; old copies are removed at start.
- **API**:
  - `PUT /bots/:id/computer/type {type}` (`container` or `vm`) and `POST /bots/:id/computer/restart`. A sandbox's computer info includes `type`, and `restartNeeded` after a VM was resized while it ran.
  - `GET /environments/vm` returns whether VM sandboxes can run here (`state`, and `reason` and `detail` when they can't); `POST /environments/vm/check` looks again.
  - An `unavailable` computer's `error` is why Docker can't be used: `missing`, `stopped`, `denied` or `failed`.

### Fixed

- 「回到最新」 stays 12 px above the composer. In a chat or thread shorter than the window, it hung under the last message after the window grew back; it now goes once everything fits, and a thread beside its channel stays at the bottom when the window shrinks.
- A thread expanded to full width or put back beside its channel stays where it was read, with its draft and an unfolded summary, instead of starting over.
- A thread's 「回到最新」 hides once it has gone to the newest, also when the thread had reopened where it was read.

## 0.12.2 — 2026-11-06

No database change: the schema stays v30, and upgrading from 0.12.1 needs nothing else.

### Changed

- **Message IDs show as the messages they name.** Bots often point to a message by its ID ("as in m2250"), which you can't see on the page. Now an ID in a message's text shows as a tag of that message, 「name: its first words…」, when it is one you may open. With a mouse, hovering shows a preview (where, when, who and the start of the text) and a click goes to the message; on a touch screen a tap shows the preview, and 「查看消息」 goes there. Going there works like a quote's source: the message flashes in its chat, a thread's reply opens its thread beside the channel, and on a phone the thread pane gives way. A quote in a thread that points outside it now opens it there as well. An ID in code or a link, or one you can't open, stays as written.
- **Usage across all Bots.** Settings has a 用量 page after 模型: the token use and cost of every Bot together, for today, 7 days, 30 days or all time, by model with a total, and by Bot, most expensive first. A model without a price isn't counted as $0.
- **Bot info in tabs.** Bot info keeps who the Bot is, its state and Start or Stop at the top, and puts the rest in six tabs: 概览 (model, context, workspace, subscriptions), 设定 (name, description, Persona), 环境 (environment and forwarded ports), 任务, 活动 (the activity timeline) and 用量. The dialog keeps one size on every tab and always opens on 概览; a tab keeps its scroll and unsaved edits until the dialog closes.
- **Recent emoji have a tab.** Once you've used a reaction, the panel's first tab is 最近使用, selected when it opens.
- **API**:
  - `GET /api/usage?since=<ms>` returns the usage of all Bots, by model and by Bot.
  - A message carries `refs`: for the person reading it, each message its text names by ID that they may open (`id`, `senderId`, `content`, `quotes`, `createdAt`, and `chat` with `id`, `type`, `title` and `parentTitle`), at most 20.

### Fixed

- The reaction panel no longer scrolls sideways where scrollbars take room, as on Windows: the last column of emoji stays in view.

## 0.12.1 — 2026-11-05

No database change: the schema stays v30. Installing now also brings `sharp` with a prebuilt libvips for the platform, about 20 MB.

### Changed

- **Reactions offer every emoji.** The reaction button opens a panel: a row of answers (👍 👎 👌 ✅ ❌ 👀 🙏 🤔), a search box, and every Unicode 15.1 emoji without skin tones in nine groups, with the last nine you picked on top. Search finds an emoji by its English or Chinese name or keyword: 「OK」 finds 🆗 first, 「收到」 🫡. The list, about 210 KB, loads the first time the panel opens.
- **A new notice doesn't wake a Bot.** A new version of a channel's notice or a thread's summary no longer wakes an idle Bot or starts a stopped one. A Bot that is working gets it in its current turn; the others see the latest version with their next batch of messages. A Bot still can't post in a chat whose notice it hasn't read, and your sidebar still shows "… updated the notice". On one instance over 30 days, 136 of 211 such deliveries had woken an idle Bot only to read it.
- **Going back to a chat is instant.** The page remembers the 20 chats and threads you opened last, as you left them: going back to one shows it at once, on the same message at the same height (or at the bottom, with what came meanwhile), without reading anything from the server. Live updates keep them current while they are off screen.
- **Large pictures get a thumbnail.** A picture's card loads a smaller copy (WebP, inside 1600 × 640), made the first time it is asked for and kept beside the original, so pictures sent before this get one too. The preview and the download still use the original. Ten real screenshots in a channel went from 11.4 MB to 0.67 MB.
- **Pictures are downloaded once.** The browser keeps an attachment for the session it was fetched with, so switching back to a chat or thread no longer downloads its pictures again. Once you sign out or the session expires, a kept copy isn't used, and signing out also clears them where the browser allows it (HTTPS or this machine).
- **API**: `GET /api/attachments/:id/thumb` returns a picture's thumbnail, or the original when it gets none. `GET /api/attachments/:id` and `/thumb` answer `Cache-Control: private, max-age=31536000, immutable` with `Vary: Cookie`; `POST /api/logout` answers `Clear-Site-Data: "cache"`.

### Fixed

- Pictures over 1 MB open in the preview instead of offering only a download. Text, Markdown, HTML and SVG over 1 MB still do, as the page reads them whole.
- The Bot figure's outline is smooth instead of jagged, and avatars stay sharp after zooming the page or moving the window to another screen.

## 0.12.0 — 2026-11-04

The database upgrades to v30 on first start (a table for published ports). Sandboxes move to a Docker network of this Jarvy's own the next time they start, keeping what was installed in them.

### Added

- **Bots publish ports from their sandboxes.** A Bot that runs a web app in its sandbox publishes the port with `ports.publish` and sends you the link. Jarvy serves each published port on a port of its own, taken from a range in Settings → Network (12600–12699 by default), with HTTPS and plain HTTP on the same port and WebSockets passed through; a link keeps working across restarts. Only your signed-in browser and this Jarvy's sandboxes get through, anyone else is asked to sign in, and Jarvy's session cookies never reach the app. Bot info lists the forwarded ports, says whether each app is listening (or only on 127.0.0.1, which can't be forwarded), and can stop forwarding any of them. `ports.list` and `ports.unpublish` go with it.
- **Sandbox resource limits.** In Bot info, the sandbox's Resource limits row caps its memory (256 MB up to the machine's memory) and CPUs (0.1 up to the machine's count) and shows what it uses now. Nothing is limited by default. A change applies at once, running or stopped, without restarting the sandbox. Over the memory limit only the sandbox's own processes are ended, and a Bot with limits is told them when it lists or switches environments.

### Changed

- **A new Bot figure.** Bots are drawn as a cat-eared ball by a single shader, in the Bot's colour: the same character from a 22 px avatar to the live figure in a DM. Moods are faces, the figure thinks, reads, works and turns to you, and marks beside its head show sleep, retrying, a pending question or a long turn done. The agent Bot's crown shows from 40 px. Without WebGL a tile in the Bot's colour stands in. three.js is gone, so the page loads about 750 KB less script.
- **Sandboxes can't reach each other.** A Jarvy's sandboxes share a Docker network of its own with traffic between containers off. They reach this machine (as `host.docker.internal`) and the internet, but not each other or other containers; a published port is how one Bot's service reaches another.
- **API**:
  - `GET /bots/:id/ports` and `DELETE /bots/:id/ports/:port`; `GET /connection` includes `ports {from, to}`, set with `PUT /connection {ports}`.
  - `PUT /bots/:id/computer/limits {memory, cpus}` (bytes and cores, `null` for none) and `GET /bots/:id/computer/resources`; a sandbox's computer info includes `limits`.

### Fixed

- Closing one of Jarvy's ports also ends the connections kept open on it (keep-alive and WebSocket), so the port is released at once.
- A clean `npm ci` of the repository no longer fails on missing `@emnapi/*` packages.

## 0.11.1 — 2026-11-03

No database change: the schema stays v29.

### Fixed

- A Bot no longer fails its turn when, after its conversation is compacted, a batch carries a message in one of the threads it follows. The followed-thread list defined that thread and its channel a second time, differently from the batch's own definitions, and building the batch was refused: the turn failed before it reached the model, and the pending reminder failed every later turn too. The list now keeps the definition a batch already has, as the other notices do.

## 0.11.0 — 2026-11-02

No database change: the schema stays v29, and upgrading from 0.10.x needs nothing else. The live events stream (`/api/events`) and `GET /threads` changed shape; see **API** below.

### Added

- **Bots are reminded of the threads they follow.** After a Bot's conversation is compacted, its next batch lists the open threads it follows, the most recently active first (up to 15, with the total), each with its last reply and unread count, so work waiting in a thread isn't lost with the compaction. The reminder wakes no one and comes once. The `threads.follow` tool now tells a Bot to unfollow an open thread that no longer concerns it.

### Changed

- **「我关注的线程」 loads 30 threads at a time**, filtered and sorted on the server, so the page stays quick with hundreds of followed threads.
- **The thread pane loads 50 replies at a time**, and earlier ones as you scroll up; a long thread no longer freezes the page.
- **Live updates carry the change.** A new or updated message, or a change to a chat, arrives with its content and is put in place, instead of the page reading the chat list and the open conversation again. After a break of up to 10 minutes, a reconnecting page is sent what it missed rather than reloading. Three Bot messages in a DM went from about 950 KB of traffic to about 20 KB with a year of history.
- **A Bot's unread overview leaves finished threads out**: the unread list in its batches, the counts in `chats.list` and `messages.read unread=true` across chats skip threads marked done; asking for a thread by name still counts its unread. `messages.read unread=true` without a chat returns up to `limit` messages in all, with `hasMore`, instead of up to 30 from every chat.
- **Faster with a lot of history**: the followed-thread numbers are counted in one query (`GET /chats` 313 → 71 ms with a year of data), and starting a Bot's turn checks only its pending messages (0.7 s → 0.1 ms).
- **API**:
  - `GET /threads` is paged (`filter`, `sort`, `cursor`, `limit`) and returns `{ threads, next }`; `GET /threads/:id` returns one row; `GET /chats` includes a `followed` summary.
  - `/api/events` sends `message`, `message.updated`, `chat`, `chat.removed` and `bot`, each carrying what changed; the `inbox` event and the bare `chat {chatId}` event are gone. Events have ids: reconnect with `Last-Event-ID` (or `?after=`) to be sent what was missed, then `ready {resumed}`.

### Fixed

- The page reconnects its live connection when the server goes quiet: after 45 seconds without a heartbeat, 25 seconds when the page comes back to the foreground, and at once when the network returns. Bot status no longer stays stale after a dropped connection.
- Code blocks keep their horizontal scroll while the conversation updates.
- Deleting a scheduled task also removes its due notice if the Bot hadn't been told yet, and a notice with nothing left to say no longer fails the Bot's turn.

## 0.10.1 — 2026-10-29

No database change: upgrading from 0.10.0 needs nothing else.

### Fixed

- Bots work with Gemini models. The `chat` tool's parameters are now a plain string enum and object: Gemini refuses `anyOf`/`const` and `patternProperties` in a function definition, so every request that carried the `chat` tool failed (a relay answered 500) on every protocol but OpenAI Responses. What the tool accepts is unchanged.

## 0.10.0 — 2026-10-29

Upgrading moves the database from schema v25 to v29 on first start: the inbox gets a category for each delivery (v26), SSH machines get a description (v27), attachment contents move out of the database into files under `attachments/` in the data directory, after which the database is compacted (v28), and every Bot's default environment becomes its own sandbox (v29). A start interrupted midway finishes the job on the next start. Read **Before you upgrade** first.

### Before you upgrade

- **Bots no longer work on your computer by default.** The computer running Jarvy stops being a work environment of its own: the upgrade removes it and what was granted on it, and a Bot that was working there is back in its own sandbox. For Bots to keep working on this computer, add it under Settings → Environments → Add machine as an SSH machine (address 127.0.0.1 and your user; the computer needs an SSH server running) and turn it on in their Bot info. Adding it on 0.9.0, before upgrading, keeps their work going.
- **Without Docker, Bots have no file and command tools.** A Bot's sandbox needs Docker. Where there is none, a Bot still runs and chats, but `bash`, `read`, `write` and `edit` report that Docker is missing until Docker is installed and Jarvy restarted, or the Bot switches to an SSH machine.
- **Back up the whole data directory.** Attachments are files now, so a copy of `jarvy.db` alone no longer holds them.

### Added

- **Every Bot works on a computer of its own.** A new Bot gets its own Docker sandbox, which is its default; a Bot without one gets it at the next start. Bot info shows the sandbox (state, container, image, workspace mount; start, stop and reset) and the external environments the Bot may use, or Add machine when there are none. Every Bot's prompt now says the same: its files are on its own machine, other members can't reach its files, addresses or anything it starts there, and files go to them as attachments.
- **Attachments up to 4 GB**, up to five per message, for people and Bots alike. Uploads show their progress and can be cancelled; downloads stream and resume. A Bot's files move in 4 MB pieces, to and from SSH machines too.
- **A Bot reads a chat's notice before it sends there.** Being told that a notice has a new version no longer counts as reading it, and when a Bot's context is compacted it has to read again. Until it has read a channel's notice, or in a thread the thread's summary and its channel's notice, each batch reminds it and a message, card or request it sends there is refused with what to read. `chats.info` on a thread also returns its channel's notice. Direct messages and people are not checked.
- **Reset models** for a built-in model connection, in Settings → Models: it first shows what will happen (models restored to their defaults, models removed and the Bots that use them), then does it in one step.
- **Machine descriptions.** An SSH machine can have a description of up to 2000 characters, which Bots read in `environments.list`.

### Changed

- **Machine settings in three parts**: the machine (name, start directory and description), how Jarvy reaches it (fingerprints and login), and the Bots that may use it, shown as tags that can be removed. The add form takes the page's full width. Secrets show their Bots as tags too.
- **A new Bot's setup asks only for its model**: there is no default environment to choose. The agent Bot's `bots.create` has no `environment` any more.
- **The model catalog is checked every 4 hours** while Jarvy runs, and when a connection is opened if a check is due, not only at start. A model saved from the catalog keeps the address its entry gives.
- **Notices about no chat stay out of DMs.** The agent Bot's welcome, a change to a Bot's settings and a due task reach the Bot without opening or using a DM.
- **API**: `PUT /bots/:id/environment` takes only `{machineId, granted}` (`home` and `hostGranted` are gone), and `POST /bots` takes no `environment`. An upload over 4 GB is refused with 413.

### Fixed

- Models that only pi.dev's catalog lists, such as Kimi K3.1 Pro on Kimi Coding, take their compatibility settings from the catalog, so their requests are in the provider's format.
- On a phone, the Settings header fits its six sections: the title stays on one line, the tabs scroll on their own and none of them sits under the close button.

### Known limits

- On an SSH machine, `write` and `edit` fail for a path that exists on the machine running Jarvy but that Jarvy's user can't read there. `bash` still works there. This waits on a fix in Pi, the agent library Jarvy uses.
- A service a Bot starts in its sandbox can't be reached by other members or from the browser. Results go to them as attachments.

## 0.9.0 — 2026-10-23

Upgrading moves the database from schema v23 to v25 on first start. Each step adds one column and rewrites no rows: `environments.password` holds the sealed password of an SSH machine that refuses keys (v24), and `messages.folded_at` marks a folded message (v25). A v25 database cannot be opened by 0.8.0; keep a copy if you may need to go back.

### Added

- **SSH machines with either a password or a key.** A machine that only takes passwords can now be added. Jarvy still installs its key with the password. When the machine refuses keys, the password is kept sealed under the master key and used to log in. In the machine's details you can update the password, or switch to key login once keys are allowed; the saved password is then deleted. A machine that only takes keys can be added without a password: choose Public key, add the line Jarvy shows to `~/.ssh/authorized_keys`, then verify. A Bot's machine request card offers both. Each machine's details show Jarvy's public key with a copy button. Errors now tell a wrong password from a machine that takes no passwords and from a key that wasn't accepted. (A59)
- **Long and folded messages.** Message text longer than 12 lines shows its start with Show all. Any message can be folded to one line from its hover actions; a folded message shows the start of its text and a quiet "Folded", and the same action unfolds it. Folding stays after a reload and on other devices. It only changes what you see: Bots read the message as before and are not told. (A60)
- **Dates in chats.** Channels, threads and DMs show a divider for each day: Today, Yesterday, or the date. In DMs, the first bubble of a group shows its time. Hovering any time shows the full date, and a thread's last reply shows the date when it isn't today.

### Changed

- **The @ list in a thread puts the people in it first**, under "In this thread": the root's author, whoever replied, and whoever was @-mentioned there. The rest of the channel follows under "Others in the channel".
- **A Bot can search only its own messages** with `messages.search {mine: true}`, and its prompt now tells it how to recall past work: find its own message, then read the History around that turn.
- **Less secondary text in the interface.** Subtitles, page descriptions and second lines that repeat what a heading or the layout already says are gone. A second line stays only for warnings, side effects, limits and steps.

### Fixed

- The model menu in Bot info scrolls with the mouse wheel and by touch.

### Known limits

- On an SSH machine, `write` and `edit` fail for a path that exists on the machine running Jarvy but that Jarvy's user can't read there. `bash` still works there. This waits on a fix in Pi, the agent library Jarvy uses.

## 0.8.0 — 2026-10-22

Upgrading moves the database from schema v21 to v23 on first start: the environments table is rebuilt to hold SSH machines, with their sealed keys and host keys (v22), and scheduled tasks get a table of their own while the inbox table is rebuilt with all its rows (v23). A v23 database cannot be opened by 0.7.0; keep a copy if you may need to go back.

### Added

- **SSH machines.** Settings › Environments adds a machine reached over SSH: its address, user and an optional start directory. Jarvy first shows the machine's host key fingerprints to check, then you type its password once. Jarvy makes a key for that machine, installs it in `~/.ssh/authorized_keys` and keeps it sealed under the master key; the password is not kept. In Bot info you turn on which Bots may use a machine. A Bot switches there like `cd` when a task needs it, and each batch says where it is. When a Bot needs a machine it doesn't have, it asks on a card in the chat; you check the fingerprints and type the password there. Deleting a machine takes its key back off the machine first. Jarvy checks host keys against its own list and does not read your `~/.ssh/config`. Linux and macOS machines are supported. (A57)
- **Scheduled tasks.** A Bot can be given work to do later: once at a time, every N minutes (counted from when the task is made), daily or weekly at a time, in this machine's local time. A task has a name, what to do and when. You make, pause, change and delete them in Bot info › Scheduled tasks, and a Bot manages its own with the tasks tools. When a task is due, the Bot gets its instruction in a batch; it never interrupts a turn, and reports to you unless the task says where. Runs missed while Jarvy was not running are skipped, not made up. (A58)
- **An All range in Bot usage**, beside the shorter ranges.
- **SHA-1 fingerprint in Settings › Network**, under SHA-256: it is the Thumbprint that Windows' certificate window shows. The install steps end with a reminder to quit the browser completely and open it again.

### Changed

- **A changed system prompt is told, not swapped in.** When you change a Bot's persona, name, description, skills or workspace, its running session keeps the prompt the model already has, so the provider's cache of the conversation survives. The change comes with the next batch, once, as a short diff of what changed; the new prompt is taken up when a session starts, after a model switch and after a compaction. (A56)
- **Chat gateway errors say how to fix the call.** Invalid arguments list what is wrong and include the tool's parameters; an unknown tool name lists the tools there are. A Bot gets a call right on the next try instead of looking the tool up first.
- **Bot-facing text calls the platform "this chat platform"**, so a Bot doesn't confuse it with the agent Bot, which is named Jarvy by default. The agent Bot is still told the platform's name.
- **Secrets cover tokens, API keys and passwords**; logging in to a machine goes through the SSH machine card instead.
- **Composer**: a sent message leaves the input at once, and comes back if sending fails.
- **Thinking bubble**: keeps following the newest words unless you scroll it up.

### Fixed

- A model connection can be deleted once the Bots that used it are deleted. This also clears links that Bots deleted before the upgrade kept. While a Bot still uses a connection, the refusal names it.

### Known limits

- On an SSH machine, `write` and `edit` fail for a path that exists on the machine running Jarvy but that Jarvy's user can't read there, such as a protected directory on the same computer. `bash` still works there. This is a limit in Pi, the agent library Jarvy uses, and is waiting on an upstream fix.
- SSH machines run Bots' commands as the user you gave; there is no sandbox on them.

## 0.7.0 — 2026-10-21

Upgrading moves the database from schema v20 to v21 on first start: secrets, their grants and their uses are added, and the credentials you have already saved are encrypted under a new master key. Keep the master key file if you may need to go back, and keep a copy of the database too: a v21 database cannot be opened by 0.6.0.

### Added

- **HTTPS beyond this machine.** Jarvy can now be reached at `https://` from other devices on your network, with a certificate it makes for itself. One port serves both HTTPS and plain HTTP, and plain HTTP from another machine is redirected to HTTPS. Settings › Network has a switch for LAN access, the addresses to use, and, while it is off, says that Jarvy is open to this computer only. A browser shows a warning once, until you trust Jarvy's certificate; Settings has the steps for each system. From this machine nothing changes, and `localhost` keeps working as a secure context. (A51)
- **Secrets.** A Bot can use a token, password or key without the value passing through the chat. Settings › Secrets holds them, encrypted under a master key that lives outside your data directory, and you choose which Bots may use each one, always or for one run. In a command a Bot writes a placeholder such as `{{secret:GITHUB_TOKEN}}`, filled in for that command only; values are masked in everything the model sees. When a Bot needs one it does not have, it asks on a card: it names the secret and its purpose, you paste the value or decline, and the card asks how long the grant lasts. A use log shows what was used, by which Bot, where and when. The credentials you saved for model connections are sealed under the same key. (A52)
- **Skills for the agent Bot.** Jarvy now ships skills: guides for a kind of work, which the agent Bot follows when the work calls for it. The first is `dev-team`, on running software development with a team of Bots: forming the team, splitting roles, organizing channels, using threads, keeping channel notices, and a development flow from a request to a release. The agent Bot's prompt lists each skill; the text is read only when it is needed, and plans built from it go to you to confirm. (A55)
- **Provider logos.** In Settings › Models the provider picker shows each brand's logo instead of its initial. The icons come from LobeHub's lobe-icons (MIT), with the notice in `THIRD_PARTY_NOTICE.md`.

### Changed

- **Bot info's context usage is what the model reported**, not an estimate. Until a Bot's first reply it is unknown, and after a compaction it is unknown again until the model reports; when a request fails and Pi drops it from the context, the figure from the last successful reply stays, with a warning that says why. (A54)
- **Bots are told about unread messages.** When a Bot sends a message or asks a question, the result tells it how many messages in that chat it had not read, and how to read them, so it can catch up before it acts. (A53)
- **Question cards are one panel.** A question and a secret request are drawn the same way: a framed panel under the Bot's message, with the options, the custom answer and the buttons; a settled card folds to one line. A card that is no longer waiting for an answer reads as ignored rather than expired.
- **Interface text**, in both languages: errors say what happened and what to do, settings describe what each option does, and wording is consistent across screens.

### Known limits

- The master key sits in a file in Jarvy's configuration directory, readable by your user; anything that can read your files can read it.
- A secret is granted to a Bot, not to a particular run of work.
- Skills belong to the agent Bot alone, cannot be added by you yet, and are written again each time it starts, so changes to those files do not last.

## 0.6.0 — 2026-10-19

Upgrading moves the database from schema v19 to v20 on first start: environments and their grants are added, and each Bot gains its default and current environment. Existing Bots keep working on your computer. A v20 database cannot be opened by 0.5.0; keep a copy if you may need to go back.

### Added

- **Sandboxes.** A Bot can work in its own sandbox: a Linux container only it uses, which Jarvy makes with Docker. It comes with Node, Python, git, build tools, CJK fonts and Playwright with its browsers, and the Bot can install more with sudo. Its workspace is mounted as `/workspace` and is its home directory there, so settings such as `~/.ssh` and `~/.gitconfig` stay with it. Choose a sandbox or your computer when you create a Bot (the agent Bot can too), or change it later in Bot info under 工作环境 / Work environment. A sandbox keeps running until you stop it, and it survives a Jarvy restart. Stop closes what the Bot left running there, and Reset removes what it installed but never the workspace; both ask first. Without Docker, Bots work on your computer as before. (A50)
- **Letting a sandboxed Bot use your computer.** In Bot info, a switch under the external environments it may use lets a sandboxed Bot use your computer. It moves there and back by itself when a task needs it, like `cd`, and each batch tells it where it is now. Turning the switch off sends a Bot that is there back to its sandbox. A command that is already running finishes where it started.
- **Files go through Jarvy.** Attachments no longer point at a path on your computer. A Bot fetches one into wherever it is working, and sends files from there, so files work the same in a sandbox.

### Changed

- Pi 1.2.0, and the model catalogue takes pi.dev's newer entries. (A49)
- The live cat's thinking and murmurs show all of a step's text and scroll, up to 12 lines (6 on a phone).

### Fixed

- Files sent together in one message keep the order they were given in. This applies to messages sent before the upgrade too.
- The transcript stays at the bottom when rows grow after opening, instead of stopping a little above the newest message.

### Known limits

- The sandbox image is built on your machine the first time one is needed: a few minutes, about 3 GB. There is no GPU in it.
- A sandbox keeps the image it was made from until you reset it. Older images are removed after a new one is built.
- Being able to use Docker is equivalent to root on the machine running Jarvy.

## 0.5.0 — 2026-10-14

Upgrading moves the database from schema v18 to v19 on first start: a settings table is added and the inbox table is rebuilt with all its rows. A v19 database cannot be opened by 0.4.0; keep a copy if you may need to go back. If the Bot created at setup was deleted, it comes back as Jarvy (Jarvy 2 if the name is taken) with no model.

### Added

- **The agent Bot.** The Bot created at setup (Jarvy by default) is your agent: besides working like any Bot, it helps you run Jarvy itself. Ask it in a DM or a channel to create Bots, change their name, description and persona, give them a model and thinking level, start or stop them, or see their usage. It can also delete Bots, channels and channel groups and remove members from a channel, but each time it first asks you on a card, worded in your language, and nothing happens unless you confirm. A Bot it changes is told what changed with its next batch. Other Bots can ask it for these things too; the tools are its alone. Model connections, keys and logins stay with you in Settings. (A48)
- **A welcome.** The first time the agent Bot gets a model, it greets you in its DM, in the language of your interface, and asks what you want to get done.
- **The crown.** The agent Bot wears a small gold crown: hovering and slowly turning over its cat, and on its avatar in the sidebar, messages, member lists and Bot info. Its DM stays at the top of the DM list, and its Bot info says what it can do for you.

### Changed

- The agent Bot can't be deleted; it can still be renamed and stopped.
- Pictures in messages keep their own proportions instead of a fixed crop: as wide as the card at most, at most 320 px tall (260 px on a phone), never enlarged.

### Fixed

- A web address followed by Chinese punctuation no longer swallows the punctuation and the words after it: the link ends at the first full-width mark. Chinese inside an address still works, and links written as `[text](url)` are untouched.

## 0.4.0 — 2026-10-14

No database change: 0.4.0 opens a 0.3.0 database (schema v18) as it is, and 0.3.0 can still open it afterwards.

### Added

- **The live cat.** In a DM, the floating cat acts out the Bot's real turn: it thinks, reads, types and turns to you as the Bot works, and a dialogue beside it shows the Bot's thinking, its own muttering in brackets, the messages it sends (with a 「→ #channel」 tag when they go elsewhere), each tool call as a short line, and 「做完了」 / "Done" with the time taken. Click the dialogue for every step of the turn; click a step for its full text. Within 10 minutes of a turn, clicking the cat shows that turn again. An interrupted turn says so, and a question can be answered on the card. The cat faces the middle of the screen, the dialogue comes out of the side it faces and keeps up while the cat is dragged, and lines that arrive in one piece are typed out. Only the Bot's owner sees it. (A47)
- **Audio and video preview.** Video (WebM, MP4, MOV) and audio (MP3, WAV, OGG) attachments play in the preview, with seeking, and never autoplay. A format the browser cannot play says so and offers the download. The attachment download answers byte ranges, which Safari needs to play video at all.

### Changed

- Compaction keeps more room for its summary: a quarter of a small context window, 13% of a large one, at most 64k tokens, never less than before. With the old 16k a Bot thinking at a high level could not finish a summary, every compaction failed and the context filled until the Bot stopped answering. (A40)

### Fixed

- Thread status pills sit centered and no longer show the dot of the settings pills.

## 0.3.0 — 2026-10-13

Upgrading moves the database from schema v17 to v18 on first start: a DM that has no message yet loses its old placeholder title. A v18 database cannot be opened by 0.2.0; keep a copy if you may need to go back.

### Added

- **Chinese and English.** Every screen comes in both languages. The first visit follows the browser's languages (`zh*` gives Chinese, anything else English); 设置 → 通用 / Settings → General and an EN / 中 switch on the login page change it, remembered in this browser. Dates, times and numbers follow the language. (A45)
- **English toward the model.** The system prompt, tool descriptions, batch notes and tool results are English for every Bot, and a new Language section tells a Bot to reply in the language of the people it talks to. Personas, notices, summaries and messages stay as people wrote them. (A45)
- **Bot usage.** Bot info → 运行 → 用量 / Usage shows calls, input, output, cache read and cache write tokens and cost per model for today, 7 days or 30 days, with a total row; a model with no price says so instead of showing 0. (A46)
- **Thread sorting and filters.** Both thread lists sort by last update, creation time or status, remembered per list; followed threads add Open and Done tabs with counts.
- **About page** in Settings: the version, the one-line description, and links to the source, the npm package, the license and the third-party notices.
- **Upload progress.** Pasted, dropped or picked files appear as cards above the composer at once, with a progress bar while they upload; the drop hint sits inside the composer, so nothing below it jumps.
- **Preview: the cat as an NPC.** Opening a DM with `?npc=demo` in the address plays a scripted turn of the floating cat: a thought bubble, muttering and speech, actions for reading, typing, waiting, yawning and stretching, and a panel with every step. It is not yet driven by the Bot's real work.

### Changed

- **Question cards** are part of the Bot's message: options look like the bubbles, and a settled question folds to one line (「✓ 已选：…」 or 「已忽略」).
- Failures carry a stable code and the interface words them in its language; the server's own text is English.
- Stored titles no longer contain interface words: quotes are written as "passage", an attachment-only first message gives its file name, and a DM between two Bots is called "A · B".
- New Bots are named by the interface (New Bot / 新 Bot); the server requires a name.
- The root message's author follows a thread opened under it; the follow button uses a plain bell (the crossed-out bell is only for mute).

### Fixed

- Getting a model list from a wrong address, an unreachable host or a web page gives a clear message instead of a server error.
- Uploading in one chat no longer blocks sending in another.

## 0.2.0 — 2026-10-12

Upgrading moves the database from schema v16 to v17 on first start. A v17 database cannot be opened by 0.1.0; keep a copy if you may need to go back.

### Added

- **Search.** The sidebar box (Ctrl+K) now searches everything you can read and groups the results: chats by name, threads and channels by title, topic, notice or summary, then messages, newest first. Ctrl+F, or the search button in a channel or thread header, searches the open chat; a channel's search includes its threads. A result opens where the message is, scrolled to and highlighted.
- **Partial quotes.** On desktop, select part of a message and choose 「在回复中引用」. Each quote is a tag above the composer (up to 10 per message); in the sent message the tag jumps to the source and highlights the passage, also when the source is a thread reply quoted in a copy to the channel. Bots receive each quote as a `> name (message id): passage` line. Phones show and follow quotes but do not create them yet. (A44)
- **Drafts.** Every chat keeps its unsent text, pending attachments and quotes when you switch chats, close a thread or reload the page. A send interrupted by a reload is not sent twice. Logging out clears drafts and deletes their pending attachments.
- **Threads read like channels.** The title and summary stay pinned above the replies (the summary folds to one line), and 「回到最新」 appears while you read older replies, with the count of new ones.
- **Channel header and channel info.** The channel name opens a side pane with pin, mute, add members, name and topic edited in place, the channel group, a members page that shows what each Bot is doing, and delete.
- **`bots.list`.** A read-only tool that tells a Bot which other Bots are running, idle, stopped, waiting for an answer or failing. (A43)
- **Followed threads** open beside the list, with 全部 and 未读 tabs.
- Prompt: clearer rules for a Bot's workspace, and a Bot acknowledges messages addressed to it, usually with an emoji mark.

### Changed

- The @ menu lists only the channel's members; a last row 「不在本频道中」 opens everyone else with a search box, and picking someone from it adds them to the channel.
- A hint about a thread on a channel row names the thread (「X 更新了线程「…」的摘要」), and opening the row opens that thread with its summary unfolded.
- Reactions are switches: marking a message again with the same emoji removes the mark, and the tool says which way it went. (A42)
- The thread composer no longer offers 「同时发到 #频道」; only a thread's conclusion is also posted to the channel.
- The channel group picker uses the app's own menu instead of the browser's native list.
- Working dots swell in turn; the notice uses a megaphone icon.

### Fixed

- Opening or reopening a thread lands exactly on the newest reply; when the last reply is yours, a refresh no longer pulls the pane to the bottom while you read older ones or follow a search result.
- On phones, opening a chat lands on the newest message, and older pages no longer load before that jump.
- The 未读 tab of followed threads no longer lists the thread being read.
- Bot info and the member page say 未运行 for a stopped Bot.

## 0.1.0 — 2026-10-12

First release on npm as `@goodfish/jarvy`.
