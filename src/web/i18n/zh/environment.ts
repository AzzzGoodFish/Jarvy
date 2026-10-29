import type { Part } from "../keys";
import type { environment as en } from "../en/environment";

/** 中文：工作环境 (A50)。 */
export const environment: Part<typeof en> = {
  "environment.title": "工作环境",
  "environment.own": "Docker 沙箱",
  "environment.container": "容器",
  "environment.image": "镜像",
  "environment.mount": "工作区挂载点",
  "environment.external": "外部环境",
  "environment.accessFailed": "无法修改可使用的环境",
  "environment.state.preparing": "准备中",
  "environment.state.running": "运行中",
  "environment.state.stopped": "已停止",
  "environment.state.failed": "启动失败",
  "environment.state.unavailable": "不可用",
  "environment.hint.preparing": "首次创建沙箱需要几分钟，用于在本机构建镜像。",
  "environment.hint.running": "会一直运行，直到你停止。",
  "environment.hint.stopped": "Bot 需要时会自动启动。",
  "environment.hint.failed": "启动失败，请重试。",
  "environment.hint.unavailable": "未检测到 Docker。请在运行 Jarvy 的电脑上安装并启动 Docker，然后重启 Jarvy。",
  "environment.start": "启动",
  "environment.starting": "正在启动…",
  "environment.stop": "停止",
  "environment.stopping": "正在停止…",
  "environment.stopTitle": "停止 {name} 的沙箱？",
  "environment.stopBody": "沙箱里正在运行的程序（如后台服务）会被关闭。已安装的软件和工作区文件都会保留，下次需要时会自动启动。",
  "environment.stopConfirm": "停止",
  "environment.reset": "重置…",
  "environment.resetTitle": "重置 {name} 的沙箱？",
  "environment.resetBody": "沙箱里安装的软件会被清除，恢复到初始状态。工作区文件会保留。",
  "environment.resetConfirm": "重置",
};
