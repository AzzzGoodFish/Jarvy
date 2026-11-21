<p align="center">
  <img src="src/web/public/icon-192.png" width="88" alt="Jarvy">
</p>

<h1 align="center">Jarvy</h1>

<p align="center">
  <b>运行在你本机的群聊工作区，让你和 AI Bot 像团队一样并肩协作。</b>
</p>

<p align="center"><a href="README.md">English</a> · 中文</p>

Jarvy 用起来像熟悉的团队群聊，区别在于群里的成员是拥有真实工作环境的常驻 AI Bot。在频道里把任务交给 Bot，在线程里敲定细节，再直接打开它干活的机器查看和操作成果。

<!-- Screenshot: docs/images/zh/channel.png -->

## 在聊天里和 Bot 协作

- **组一个团队。** 告诉第一个 Bot「Jarvy」你想做什么，它会帮你创建其他 Bot、分工并配置模型。支持用 API Key 或 OAuth 接入你自己的模型账号，每个 Bot 都能单独指定模型和思考强度。
- **私信、频道、线程各司其职。** 小问题直接私信；需要协作的工作在频道里 @ 对应的 Bot；关心某个具体决策就关注它的线程。Bot 可以发送文件、弹选项卡片请你拍板，也能定时跟进。图片、文档、HTML 和音视频都能直接在聊天里预览或播放。
- **换个聊天，接着做。** 每个 Bot 在它参与的所有聊天里共用同一份上下文，从频道切到私信不必重头讲起。私信里的小猫会实时展示它正在做什么；想核对某条回复的依据，打开 History 就能看到背后的每次工具调用和结果。

## 直达 Bot 的工作环境

Bot 可以在专属的 Docker 容器或 Linux 虚拟机里工作，也能通过 SSH 连接远程主机，或接入桌面客户端配对的电脑。哪些 Bot 能用哪台机器，完全由你授权。Bot 在沙箱里跑起网页应用后，还可以发来一个登录后即可访问的预览链接。

打开**环境 → 终端**，可以在不同页签里同时运行并命名多个 shell。关闭网页或断网重连后，正在运行的进程和终端输出依然保留（仅在重启 Jarvy 服务时结束）。

<!-- Screenshot: docs/images/zh/terminal.png -->

切到**文件**页签，就能直接浏览目录、流式上传或下载文件、重命名和新建文件夹。传输直连工作环境，不会混进聊天记录；需要和团队一起看时，再作为消息附件发到聊天里。

<!-- Screenshots: mobile chat and environment files -->

## 接入外部账号，由你授权

在**设置 → 连接器**里添加 GitHub、Gmail、Linear 或自定义 MCP 服务。Bot 申请的是某个具体连接（例如你的某一个 GitHub 账号），你可以选择「仅本次运行允许」或「长期允许」。开放连接并不等于放权修改：**每次写入操作仍会暂停并等待你单独确认**。

## 本地运行，数据留在自己手里

Jarvy 面向单用户，运行在你自己的机器上。聊天记录保存在本地 SQLite 数据库里，附件、Bot 工作区和会话文件分开存放；模型请求直接发往你配置的服务商。支持中英文界面，可通过电脑或手机浏览器访问，也可以下载 [Windows 或 Linux 桌面客户端](https://github.com/AzzzGoodFish/Jarvy/releases/latest)。

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
