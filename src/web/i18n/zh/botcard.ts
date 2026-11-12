import type { Part } from "../keys";
import type { botcard as en } from "../en/botcard";

/** 中文：聊天里点 Bot 头像打开的资料卡片 (A92)。 */
export const botcard: Part<typeof en> = {
  "botCard.agent": "管家 Bot",
  "botCard.state": "状态",
  "botCard.worksIn": "工作环境",
  "botCard.sandbox": "沙箱",
  "botCard.onMachine": "机器 {name}",
  "botCard.message": "发消息",
  "botCard.info": "Bot 信息",
  "botCard.open": "打开 {name} 的资料卡",
};
