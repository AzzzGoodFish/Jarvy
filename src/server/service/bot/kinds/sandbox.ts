import { COMPUTER_CWD } from "../../../infra/env/docker.js";
import { OWN_SANDBOX, type EnvironmentRecord } from "../../../shared/environment.js";
import { computerLimits } from "../computers.js";
import { computerType } from "../computer-vm.js";
import type { EnvironmentKindEntry } from "./kind.js";

/** The owner's limits on a sandbox (A75) in the Bot's words, such as "8 GB of memory and 4 CPUs"; null without any. */
function limits(record: EnvironmentRecord): string | null {
  const { memory, cpus } = computerLimits(record);
  const parts = [memory ? `${Number((memory / 2 ** 30).toFixed(2))} GB of memory` : "", cpus ? `${cpus} ${cpus === 1 ? "CPU" : "CPUs"}` : ""].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}

const sentence = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** What a VM sandbox (A101) has that a container doesn't, in the Bot's words. */
const VM = "A full Linux virtual machine only you use (systemd, full Linux kernel, swap, dedicated /workspace disk), with Node, Python, git, build tools, Playwright with its browsers, and Docker with Docker Compose: docker works there without sudo, and a port a service or container of yours publishes is a port of your sandbox. Installed software and Docker data stay until the owner resets your sandbox.";
const CONTAINER = "A Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers.";

/** A Bot's own container, the code's `computer` (A50), or its own VM (A101): only it uses it, it starts when the Bot
 * switches or works there, and its files are under /workspace. It is the Bot's home even when Docker or libvirt isn't
 * available (A68), so a switch back there always moves the Bot; its file and command tools then say why. */
export const sandbox: EnvironmentKindEntry = {
  kind: "computer", home: true, grantable: false,
  open: (record, botId, _workspacePath, deps) => deps.computers.environment(record.botId ?? botId, record),
  place: (record, botId) => ({ id: record.id, kind: "sandbox", name: record.botId === botId ? OWN_SANDBOX : "another Bot's sandbox",
    directory: COMPUTER_CWD }),
  ensure: async (record, botId, deps) => { if (deps.computers.canRun(record)) await deps.computers.ensure(record.botId ?? botId); },
  connects: false,
  summary: (record, botId) => record.botId === botId ? "own sandbox" : "another Bot's sandbox",
  describe: (record, botId, deps) => { const owner = record.botId ?? botId, most = limits(record), problem = deps.computers.sandboxProblem(owner);
    return { state: deps.computers.status(owner)?.state ?? "stopped", ...(computerType(record) === "vm" ? { type: "virtual machine (full Linux + Docker)" } : {}),
      ...(most ? { limits: `at most ${most}` } : {}), ...(problem ? { problem } : {}) }; },
  about: (record, botId, deps) => { const owner = record.botId ?? botId, most = limits(record), problem = deps.computers.sandboxProblem(owner);
    return (computerType(record) === "vm" ? VM : CONTAINER) + " You can install software there with sudo; it stays until the owner resets your sandbox, and /workspace, your home there, is kept when it is reset. Other Bots' sandboxes can't be reached from it; services of this machine that listen on all its addresses are at host.docker.internal. To show a web service of yours to people or other Bots, publish its port with ports.publish." +
    (most ? ` It may use at most ${most}; a process that takes more memory than that is ended.` : "") +
    (problem ? ` ${sentence(problem)}, so ${computerType(record) === "vm" ? "your file and command tools don't work here" : "shell commands (bash) can't run here, though your file tools (read, write, edit) still work inside /workspace"}; your chat tools work as usual.` : ""); },
  signature: record => record.id,
};
