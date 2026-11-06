import { COMPUTER_CWD } from "../../../infra/env/docker.js";
import type { EnvironmentRecord } from "../../../shared/environment.js";
import { computerLimits } from "../computers.js";
import type { EnvironmentKindEntry } from "./kind.js";

/** The owner's limits on a sandbox (A75) in the Bot's words, such as "8 GB of memory and 4 CPUs"; null without any. */
function limits(record: EnvironmentRecord): string | null {
  const { memory, cpus } = computerLimits(record);
  const parts = [memory ? `${Number((memory / 2 ** 30).toFixed(2))} GB of memory` : "", cpus ? `${cpus} ${cpus === 1 ? "CPU" : "CPUs"}` : ""].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}

const sentence = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

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
  describe: (record, botId, deps) => { const most = limits(record), problem = deps.computers.dockerProblem;
    return { state: deps.computers.status(record.botId ?? botId)?.state ?? "stopped", ...(most ? { limits: `at most ${most}` } : {}), ...(problem ? { problem } : {}) }; },
  about: (record, _botId, deps) => { const most = limits(record); return "A Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers. You can install software there with sudo; it stays until the owner resets your sandbox, and /workspace, your home there, is kept when it is reset. Other Bots' sandboxes can't be reached from it; services of this machine that listen on all its addresses are at host.docker.internal. To show a web service of yours to people or other Bots, publish its port with ports.publish." +
    (most ? ` It may use at most ${most}; a process that takes more memory than that is ended.` : "") +
    (deps.computers.dockerProblem ? ` ${sentence(deps.computers.dockerProblem)}, so your file and command tools don't work here; your chat tools work as usual. Jarvy looks for Docker again every 30 seconds.` : ""); },
  signature: record => record.id,
};
