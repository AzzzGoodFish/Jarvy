<p align="center">
  <img src="src/web/public/icon-192.png" width="88" alt="Jarvy">
</p>

<h1 align="center">Jarvy</h1>

<p align="center">
  <b>你和 AI Bot 一起工作的本地群聊。</b>
</p>

<p align="center"><a href="README.md">English</a> · 中文</p>

在频道里把事情交给 Bot，在线程里敲定一个决定，再到它工作的机器上看成果。在这个示例项目里，Robin 和两个 Bot 正在做一份步行指南：频道里有最新的地图，右侧线程里留着封面为什么选河畔路线的讨论。

<!-- Screenshot: docs/images/zh/channel.png -->

## 在聊天里和 Bot 协作

- **组一个团队。** 告诉第一个 Bot「Jarvy」你想做什么，它能帮你创建其他 Bot、分配角色、选择模型。你可以用 API Key 或 OAuth 接入自己的模型账号，分别设置每个 Bot 的模型和思考强度。
- **让讨论有去处。** 小问题直接私信；需要大家看到的工作，在频道里 @ 对应的 Bot；只关心其中一个决定，就关注它的线程。Bot 能发文件、用选项卡片请你拍板，也能安排稍后跟进。地图、文档和录屏可以直接在聊天里预览。
- **换个聊天，接着做。** 每个 Bot 在自己参与的聊天里共用一份上下文，从频道转到私信不必重讲一遍。私信里的小猫会显示它正在做什么；想核对一条回复的依据，可以打开 History 查看工具调用和结果。

## 打开 Bot 实际工作的环境

Bot 可以在自己的 Docker 容器或 Linux 虚拟机里工作，也能通过 SSH 使用远程机器，或使用通过桌面客户端配对的电脑。哪些 Bot 能用哪台机器，由你授权。Bot 在沙箱里运行网页应用时，还可以发来一个登录后可访问的预览链接。

打开**环境 → 终端**，可以在不同页签里运行多个 shell，分别命名。关闭网页再回来，原来的进程和终端输出还在；重启 Jarvy 服务则会结束这些会话。在已连接的电脑 *Studio* 上，路线说明和印刷清样各有一个终端。

<!-- Screenshot: docs/images/zh/terminal.png -->

切到**文件**页签，就能在同一目录里浏览文件、上传或下载清样、给草稿改名或新建文件夹。文件直接传到工作环境，不会自动发进聊天；要让团队一起看，再作为消息附件分享。

<!-- Screenshots: mobile chat and environment files -->

## 接入外部账号，由你授权

在**设置 → 连接器**里添加 GitHub、Gmail、Linear 或自定义 MCP 服务。Bot 申请的是一个具体连接，比如你的某个 GitHub 账号。你可以只允许本次运行使用，也可以长期允许。允许使用连接不等于允许改数据：**每次写操作仍需你单独确认**。

Jarvy 在你自己的机器上运行，供一个用户使用。聊天记录存在本地 SQLite 数据库里；附件、Bot 工作区和会话文件另行保存。模型请求会发往你配置的服务商。可用电脑或手机浏览器访问，界面支持中英文，也可下载 [Windows 或 Linux 桌面客户端](https://github.com/AzzzGoodFish/Jarvy/releases/latest)。

## 快速开始

需要 Node.js 24（22.19 及以上也可以）。Docker 可选：装了它，Bot 就能在自己的沙箱里干活。沙箱镜像第一次用到时在本机构建，需要几分钟，约 3 GB。

```sh
npm install
npm run build
node dist/server/cli.js init      # 设置用户名和密码
node dist/server/cli.js run       # 前台运行，Ctrl+C 停止
```

打开 `http://127.0.0.1:8080` 登录。私信里已经有第一个 Bot「Jarvy」：给它选好模型（在设置里添加服务商），它就会跟你打招呼，问你想做什么。更多 Bot 从 **+** 菜单新建。启动服务不会启动任何 Bot，有内容发给 Bot 时它才会开始工作。

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

选项：`--host`（默认 `127.0.0.1`；用其他地址时同一个端口也提供 HTTPS）、`--port`（默认 `8080`）、`--data-dir`（默认 `~/.jarvy`，也可以用 `JARVY_DATA_DIR`）。`on` 和 `off` 要用同一个 `--data-dir`。

## 开发

```sh
node dist/server/cli.js run       # 后端，端口 8080
npm run dev:web                   # Vite，127.0.0.1:5173，/api 代理到 8080
```

`JARVY_WEB_HOST`、`JARVY_WEB_PORT`、`JARVY_API_PORT` 分别修改 Vite 的地址、端口和代理目标。开发页面带 Agentation 标注工具栏，生产构建不包含。

`npm run build` 会对服务端和前端做类型检查、检查分层边界、构建前端，并把服务端打包成一个文件。技术栈：后端 TypeScript + Node（Hono、`node:sqlite`），前端 React + Vite + shadcn/ui。开发约定和验证方式见 [AGENTS.md](AGENTS.md)，架构见 [docs/index.md](docs/index.md)。

## 安全

Jarvy 不是面向互联网的服务。

- 默认只监听 `127.0.0.1`。用 `--host 0.0.0.0`（或其他设备能访问到的地址）时，Jarvy 用自己生成的证书提供 HTTPS，其他机器的明文 HTTP 请求会跳转到 HTTPS。在每台设备上装一次这个证书（设置 → 网络），或者在浏览器的警告页上继续访问一次。那里也可以允许其他机器用明文 HTTP 访问，这时页面会提示密码、API Key 和对话内容以明文经过网络。
- 模型 API Key、密钥（设置 → 密钥）和证书私钥都用主密钥加密，主密钥保存在数据目录之外的 `~/.config/jarvy/`（权限 `0600`）。备份时请把它和数据目录一起保留，否则这些内容无法解密。在你的电脑上工作的 Bot 以你的用户运行，能读到它；沙箱里的 Bot 读不到。数据目录权限是 `0700`，数据库文件是 `0600`。
- Bot 默认在自己的沙箱里工作，只有得到授权才能切换到其他环境。在 SSH 机器和已配对电脑上，它能访问的范围取决于运行它的系统账号。能使用 Docker 就等于拥有这台机器的 root 权限。
- 沙箱之间互相访问不到。Bot 发布的端口由 Jarvy 另开一个端口转发（设置 → 网络，默认 12600–12699），只有已登录的浏览器和本机 Jarvy 的沙箱能访问；Jarvy 的登录 Cookie 不会转给 Bot 的应用。

## 许可证

[Apache-2.0](LICENSE)。第三方材料见 [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md)。
