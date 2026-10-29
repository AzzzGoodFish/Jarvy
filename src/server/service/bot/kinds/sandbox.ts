import { COMPUTER_CWD } from "../../../infra/env/docker.js";
import type { EnvironmentKindEntry } from "./kind.js";

/** A Bot's own container, the code's `computer` (A50): only it uses it, it starts when the Bot switches or works
 * there, and its files are under /workspace. It is the Bot's home even without Docker (A68), so a switch back there
 * always moves the Bot; its file and command tools then say Docker is missing. */
export const sandbox: EnvironmentKindEntry = {
  kind: "computer", home: true, grantable: false,
  open: (record, botId, _workspacePath, deps) => deps.computers.environment(record.botId ?? botId, record),
  place: (record, botId) => ({ id: record.id, kind: "sandbox", name: record.botId === botId ? "your sandbox" : "another Bot's sandbox",
    directory: COMPUTER_CWD }),
  ensure: async (record, botId, deps) => { if (deps.computers.available) await deps.computers.ensure(record.botId ?? botId); },
  connects: false,
  summary: (record, botId) => record.botId === botId ? "own sandbox" : "another Bot's sandbox",
  describe: (record, botId, deps) => ({ state: deps.computers.status(record.botId ?? botId)?.state ?? "stopped" }),
  about: (_record, _botId, deps) => "A Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers. You can install software there with sudo; it stays until the owner resets your sandbox, and /workspace, your home there, is kept when it is reset." +
    (deps.computers.available ? "" : " This machine has no Docker yet, so your file and command tools are unavailable here; your chat tools work as usual."),
  signature: record => record.id,
};
