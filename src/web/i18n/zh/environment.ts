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
  "environment.accessFailed": "无法更改访问权限",
  "environment.state.preparing": "准备中",
  "environment.state.running": "运行中",
  "environment.state.stopped": "已停止",
  "environment.state.failed": "启动失败",
  "environment.state.unavailable": "不可用",
  "environment.unavailable": "未检测到 Docker。安装并启动 Docker 后，请重启 Jarvy。",
  "environment.start": "启动",
  "environment.starting": "正在启动…",
  "environment.stop": "停止",
  "environment.stopping": "正在停止…",
  "environment.stopTitle": "停止 {name} 的沙箱？",
  "environment.stopBody": "沙箱中运行的程序将被关闭，已安装的软件和工作区文件会保留。",
  "environment.stopConfirm": "停止",
  "environment.reset": "重置…",
  "environment.resetTitle": "重置 {name} 的沙箱？",
  "environment.resetBody": "沙箱中安装的软件将被清除，工作区文件会保留。",
  "environment.resetConfirm": "重置",
};
