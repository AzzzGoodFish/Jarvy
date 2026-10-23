import { common } from "./common";
import { settings } from "./settings";
import { chat } from "./chat";
import { threads } from "./threads";
import { bot } from "./bot";
import { npc } from "./npc";
import { environment } from "./environment";
import { connection } from "./connection";
import { secrets } from "./secrets";
import { machines } from "./machines";
import { tasks } from "./tasks";

/** The reference dictionary (A45): every interface string of the app, English first, one part per area. Keys are
 * `area.name`; `{name}` placeholders are filled by `t()`, and an entry with `{ one, other }` picks its form from
 * `count` (Intl.PluralRules). Another language is a folder beside this one with the same parts, each covering exactly
 * the keys of its English part (see scripts/check-i18n.mjs). A key lives in one part only.
 * Wording: Bot, Channel, Thread, DM, Notice, Summary, Follow, Subscribe, Model, Connection, Thinking. */
export const en = { ...common, ...settings, ...chat, ...threads, ...bot, ...npc, ...environment, ...connection, ...secrets, ...machines, ...tasks } as const;
