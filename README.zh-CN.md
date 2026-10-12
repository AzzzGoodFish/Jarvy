<p align="center">
  <img src="src/web/public/icon-192.png" width="88" alt="Jarvy">
</p>

<h1 align="center">Jarvy</h1>

<p align="center">
  <b>你和 AI Bot 一起工作的群聊，完整运行在你自己的电脑上。</b>
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <img src="docs/images/channel.png" alt="有人也有 Bot 的频道，顶部是公告，右侧打开了线程">
</p>

Jarvy 用起来就像熟悉的团队聊天工具：私信、频道、线程，可以 @、回复、加表情。不同的是群里还有 Bot。每个 Bot 都是基于 [Pi coding-agent SDK](https://github.com/earendil-works/pi) 的常驻智能体，有自己的工作区，在它参与的所有聊天里共用同一份上下文。它只通过聊天工具说话：发消息、加表情、开线程；需要你拍板时，给你一张选择题卡片。

Jarvy 在本地运行，只有一个用户。账号、Bot、聊天、文件和模型密钥都存在你电脑上的一个 SQLite 数据库里。

## 亮点

**Bot 是成员，不是侧边栏助手。** 在频道里 @ 它、回复它的消息，或者直接私信它。发给 Bot 的内容才会送到它那里，包括私信、@、回复和它关注的线程。它工作时你发了新消息，它会被打断，马上看到。它可以在有权限的聊天里发消息、建频道、关注线程，也能用选择题卡片问你。

<p align="center">
  <img src="docs/images/bot-dm-dark.png" alt="深色模式下与 Bot 的私信：带代码块的 Markdown 回答，下面是一张选择题卡片">
</p>

**每个 Bot 一份上下文。** Bot 在所有聊天里用同一个会话，在频道里知道的事，到私信里还记得。每个 Bot 还有自己的 History，记下它想了什么、说了什么、做了什么；你可以按时间线浏览，Bot 自己也能翻看。

**未读提醒不打扰。** 只有有人 @ 你或回复你时才显示红色数字；其他消息只在侧栏显示一行预览。任何聊天都能设免打扰。

**文件。** 可以给人和 Bot 发文件，图片、Markdown、文本和 HTML 都能直接预览。带脚本的 HTML 要你确认后才会在沙箱里运行。

<p align="center">
  <img src="docs/images/attachments.png" alt="Bot 发了一张图表并 @ 了你，「以下为新消息」标出未读的位置">
</p>

**模型自己选。** 支持 API Key 和 OAuth 登录，同一个服务商可以接多个账号（比如两个 Codex 账号）。Jarvy 在本地维护模型目录，能自动配置。Bot 工作时也能切换模型和思考强度。

**手机上也能用。** 小屏幕下布局会自动调整。每个 Bot 都有一只方块猫形象，动作随 Bot 的状态变化。

<p align="center">
  <img src="docs/images/mobile.png" alt="手机上的 Jarvy：会话列表、频道和 Bot 私信" width="820">
</p>

## 快速开始

需要 Node.js 24（22.19 及以上也可以）。

```sh
npm install
npm run build
node dist/server/cli.js init      # 设置用户名和密码
node dist/server/cli.js run       # 前台运行，Ctrl+C 停止
```

打开 `http://127.0.0.1:8080` 登录。私信里已经有第一个 Bot「Jarvy」：给它选好模型（在设置里添加服务商），打个招呼就能开始。更多 Bot 从 **+** 菜单新建。启动服务不会启动任何 Bot，有内容发给 Bot 时它才会开始工作。

## 全局安装

```sh
npm install -g @goodfish/jarvy
jarvy on                          # 后台运行
jarvy off                         # 停止
```

想装自己构建的版本：`npm run build && npm pack --pack-destination /tmp && npm install -g /tmp/goodfish-jarvy-*.tgz`。

| 命令 | 作用 |
| --- | --- |
| `jarvy init` | 交互式设置账号。 |
| `jarvy run` | 前台运行。 |
| `jarvy on` | 后台运行，输出写到 `<data-dir>/jarvy.log`；还没设置账号时会先引导设置。 |
| `jarvy off` | 停止后台服务，最多等待 30 秒。 |

选项：`--host`（默认 `127.0.0.1`）、`--port`（默认 `8080`）、`--data-dir`（默认 `~/.jarvy`，也可以用 `JARVY_DATA_DIR`）。`on` 和 `off` 要用同一个 `--data-dir`。

## 开发

```sh
node dist/server/cli.js run       # 后端，端口 8080
npm run dev:web                   # Vite，127.0.0.1:5173，/api 代理到 8080
```

`JARVY_WEB_HOST`、`JARVY_WEB_PORT`、`JARVY_API_PORT` 分别修改 Vite 的地址、端口和代理目标。开发页面带 Agentation 标注工具栏，生产构建不包含。

`npm run build` 会对服务端和前端做类型检查、检查分层边界、构建前端，并把服务端打包成一个文件。技术栈：后端 TypeScript + Node（Hono、`node:sqlite`），前端 React + Vite + shadcn/ui。开发约定和验证方式见 [AGENTS.md](AGENTS.md)，架构见 [docs/index.md](docs/index.md)。

## 安全

Jarvy 不是面向互联网的服务。

- 默认只监听 `127.0.0.1`。用 `--host 0.0.0.0` 时走明文 HTTP，同一网络里的人能看到密码、Cookie 和 API Key。请只在可信网络里使用，或通过 VPN、HTTPS 反向代理访问。
- 凭据存在数据库里，没有在应用层加密。数据目录权限是 `0700`，数据库文件是 `0600`；不要分享数据库或它的备份。
- Bot 的工作区就是一个普通文件夹，不是沙箱。Bot 以你的用户权限运行 `bash`。

## 许可证

[Apache-2.0](LICENSE)。第三方材料见 [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md)。
