<p align="center">
  <img src="src/web/public/icon-192.png" width="88" alt="Jarvy">
</p>

<h1 align="center">Jarvy</h1>

<p align="center">
  <b>A local chat workspace where you and your AI Bots work as a team.</b>
</p>

<p align="center">English · <a href="README.zh-CN.md">中文</a></p>

Give a Bot a job in a channel, discuss one decision in a thread, then open the machine where it did the work. In the example project, Robin and two Bots are making a walking guide: the channel holds the draft map, and the thread records why Riverside went on the cover.

<!-- Screenshot: docs/images/en/channel.png -->

## Work with Bots in chat

- **Build a team.** Tell Jarvy, your first Bot, what you want to do. It can create other Bots, give each a role and set its model. Bring your own model connections (API key or OAuth), and choose the model and thinking level per Bot.
- **Give each conversation a place.** DM a Bot for a quick question, mention it in a channel for shared work, or follow a thread to keep a decision with its replies. Bots can send files, ask for a choice on a card and schedule a follow-up. Maps, documents and recordings can be previewed in chat.
- **Pick up where you left off.** Each Bot has one context across the chats it participates in. Moving from a channel to a DM does not start it over. Its cat avatar shows what it is doing; open History to inspect the tool calls and results behind a reply.

## Open the environment where the work happened

Bots can work in their own Docker container or Linux VM, on a machine reached over SSH, or on a computer paired with the desktop client. You choose which Bots may use each environment. When a Bot runs a web app in its sandbox, it can share a signed-in preview link.

In **Environments → Terminal**, open multiple named shells in separate tabs. Close the browser and come back to the same running shell and scrollback; restarting the Jarvy server ends those sessions. In the guide project, the route notes and print proof have their own terminals on the connected computer *Studio*.

<!-- Screenshot: docs/images/en/terminal.png -->

Use **Files** to browse the same directory, upload or download a print proof, rename a draft or create a folder. Transfers go directly to or from the environment, not into chat history. To share a file with the team instead, attach it to a message.

<!-- Screenshots: mobile chat and environment files -->

## Connect your accounts on your terms

Add GitHub, Gmail, Linear or a custom MCP server in **Settings → Connectors**. A Bot can request one named connection, such as a particular GitHub account. Grant it for the current run or on an ongoing basis. A grant lets the Bot use that connection; **each write still needs your confirmation**.

Jarvy is single-user and runs on your machine. Chats are stored in a local SQLite database; attachments, Bot workspaces and session files are stored separately. Model calls go to your configured providers. Use the English or Chinese web interface from a desktop or phone, or download the [Windows or Linux desktop client](https://github.com/AzzzGoodFish/Jarvy/releases/latest).

## Quick start

Requires Node.js 24 (22.19 or later works). Docker is optional: with it, Bots can work in their own sandboxes. Their image is built on this machine the first time one is needed, which takes a few minutes and about 3 GB.

```sh
npm install
npm run build
node dist/server/cli.js init      # choose a username and password
node dist/server/cli.js run       # foreground; Ctrl+C to stop
```

Open `http://127.0.0.1:8080` and sign in. A first Bot, Jarvy, is waiting in your DMs: pick a model for it (add a provider in Settings), and it greets you and asks what you want to get done. Create more Bots from the **+** menu. Starting the server does not start any Bot. A Bot starts when something is delivered to it.

## Install globally

```sh
npm install -g @goodfish/jarvy
jarvy on                          # run in the background
jarvy off                         # stop
```

To install your own build instead: `npm run build && npm pack --pack-destination /tmp && npm install -g /tmp/goodfish-jarvy-*.tgz`.

| Command | What it does |
| --- | --- |
| `jarvy init` | Set up the account interactively. |
| `jarvy run` | Run in the foreground. |
| `jarvy on` | Run in the background (output goes to `<data-dir>/jarvy.log`). Sets up the account first if needed. |
| `jarvy off` | Stop the background server, waiting up to 30 seconds. |

Options: `--host` (default `127.0.0.1`; any other host also serves HTTPS on the same port), `--port` (default `8080`), `--data-dir` (default `~/.jarvy`, or `JARVY_DATA_DIR`). Use the same `--data-dir` for `on` and `off`.

## Development

```sh
node dist/server/cli.js run       # backend on 8080
npm run dev:web                   # Vite on 127.0.0.1:5173, proxies /api to 8080
```

`JARVY_WEB_HOST`, `JARVY_WEB_PORT` and `JARVY_API_PORT` change the Vite host, port and proxy target. The development page includes the Agentation annotation toolbar; production builds do not.

`npm run build` type-checks the server and web code, checks the layer boundaries, builds the frontend and bundles the server into one file. The stack is TypeScript on Node (Hono, `node:sqlite`) with a React, Vite and shadcn/ui frontend. See [AGENTS.md](AGENTS.md) for how changes are made and verified, and [docs/index.md](docs/index.md) for the architecture.

## Security

Jarvy is not an internet service.

- It listens on `127.0.0.1` by default. With `--host 0.0.0.0` (or any address other devices can reach) it serves HTTPS with a certificate it makes itself, and sends plain HTTP from other machines to HTTPS. Install that certificate once on each device (Settings → Network), or accept the browser's warning once. Plain HTTP from other machines can be allowed there; the page then warns that passwords, API keys and conversations cross the network unencrypted.
- Model API keys, secrets (Settings → Secrets) and the certificate keys are encrypted with a master key kept outside the data directory, in `~/.config/jarvy/` (mode `0600`). Back that file up together with the data directory: without it they can't be decrypted. Bots that work on your computer run as your user and could read it; sandboxed Bots can't. The data directory is created with mode `0700` and the database with `0600`.
- A Bot works in its own sandbox unless you grant it another environment. On SSH machines and paired computers, its access is that of the account it runs as. Being able to use Docker is equivalent to root on this machine.
- Sandboxes can't reach each other. A port a Bot publishes gets a Jarvy port of its own (Settings → Network, 12600–12699 by default) that only your signed-in browser and this Jarvy's sandboxes get through; Jarvy's session cookies never reach the Bot's app.

## License

[Apache-2.0](LICENSE). Third-party material is listed in [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md).
