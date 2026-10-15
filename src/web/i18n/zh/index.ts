import type { Shape } from "../keys";
import { common } from "./common";
import { settings } from "./settings";
import { chat } from "./chat";
import { threads } from "./threads";
import { bot } from "./bot";
import { npc } from "./npc";
import { environment } from "./environment";

/** 中文 (A45): the parts of the English reference, put together the same way. */
export const zh: Shape = { ...common, ...settings, ...chat, ...threads, ...bot, ...npc, ...environment };
