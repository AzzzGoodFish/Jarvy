import type { Part } from "../keys";
import type { environment as en } from "../en/environment";

/** 中文：工作环境 (A50)。 */
export const environment: Part<typeof en> = {
  "environment.title": "工作环境",
  "environment.computer": "自己的电脑",
  "environment.computerHint": "只有它自己用的 Linux 容器，工作区就在里面。推荐。",
  "environment.noDocker": "需要运行 Jarvy 的电脑装有 Docker。",
  "environment.host": "你的电脑",
  "environment.hostHint": "运行 Jarvy 的这台电脑，能碰到你的文件。",
  "environment.moveHint": "改动从它的下一条命令开始生效。",
  "environment.its": "它的电脑",
  "environment.state.preparing": "准备中",
  "environment.state.running": "运行中",
  "environment.state.stopped": "已停止",
  "environment.state.failed": "出错了",
  "environment.state.unavailable": "没有 Docker",
  "environment.hint.preparing": "第一台要几分钟：镜像在这台机器上构建。",
  "environment.hint.running": "闲置一小时后会自己停下。",
  "environment.hint.stopped": "Bot 用到时会自己启动。",
  "environment.hint.failed": "没能启动，可以再试一次。",
  "environment.hint.unavailable": "运行 Jarvy 的电脑上没有可用的 Docker。",
  "environment.start": "启动",
  "environment.starting": "启动中…",
  "environment.stop": "停止",
  "environment.stopping": "停止中…",
  "environment.reset": "重置…",
  "environment.resetTitle": "重置 {name} 的电脑？",
  "environment.resetBody": "装在上面的软件会被清掉，从镜像重新开始。工作区里的文件都会留着。",
  "environment.resetConfirm": "重置",
  "environment.changeFailed": "没能切换工作环境",
};
