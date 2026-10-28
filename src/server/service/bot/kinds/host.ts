import { hostEnvironment } from "../../../infra/env/host.js";
import type { EnvironmentKindEntry } from "./kind.js";

/** The owner's computer, the machine running Jarvy (A50): an external environment a Bot is granted and switches to
 * (A67), never its default. Commands run there as Jarvy's own user, with the environment Pi builds for them; the tools
 * start in the Bot's workspace. */
export const host: EnvironmentKindEntry = {
  kind: "host", home: false, grantable: true,
  open: (_record, _botId, workspacePath) => hostEnvironment(workspacePath),
  place: (record, _botId, workspacePath) => ({ id: record.id, kind: "host", name: "your owner's computer", directory: workspacePath }),
  connects: false,
  summary: () => "owner's computer",
  describe: () => ({}),
  about: () => "The machine where this chat platform's server runs. Your tools run there as your owner and can reach their files: work in your directory, and leave other members' workspaces, live data directories (such as ~/.jarvy), main repository checkouts and system directories alone unless the task needs it; say in your reply what you changed there.",
  signature: record => record.id,
};
