import { join } from "node:path";
import { buildImage, computerImage, computerRecipe, imageExists, pruneImages, vmImage, vmRecipe } from "../../infra/env/docker.js";
import { vmProblem } from "../../infra/env/kata.js";
import type { EnvironmentRecord } from "../../shared/environment.js";
import type { ComputerType, VmSupport } from "../../../contract/environment.js";

/** A VM sandbox's size when the owner set none (A85): Kata's own default, one CPU and 2 GB, is too small to work in. */
export const VM_SIZE = { memory: 4 * 2 ** 30, cpus: 2 } as const;
/** What a Bot's sandbox is (A85), as kept with it; a container unless made a VM. */
export const computerType = (record: EnvironmentRecord): ComputerType => record.spec.type === "vm" ? "vm" : "container";
/** Where a VM sandbox's Docker disk is kept on this machine, named after its container. */
export const vmDisk = (dataDir: string, container: string) => join(dataDir, "computers", "disks", `${container}.img`);

/** The images sandboxes start from (A50, A85), built on this machine when first needed: the sandbox image, and for VM
 * sandboxes one on top of it with Docker. Building takes minutes; its output goes to `computers/build.log`. Older
 * images go once no container uses them, as each is gigabytes. */
export class ComputerImages {
  private base: Promise<string> | null = null;
  private vm: Promise<string> | null = null;
  constructor(private readonly dataDir: string, private readonly uid: number, private readonly gid: number, private readonly log: (text: string) => void) {}
  /** The tag a sandbox of this type starts from, built or not. */
  tag(type: ComputerType): string { const base = computerImage(this.uid, this.gid); return type === "vm" ? vmImage(base) : base; }
  /** The image for this type, built first when missing. */
  ready(type: ComputerType): Promise<string> {
    this.base ??= this.build(computerImage(this.uid, this.gid), computerRecipe(this.uid, this.gid)).catch(error => { this.base = null; throw error; });
    if (type === "container") return this.base;
    this.vm ??= this.base.then(base => this.build(vmImage(base), vmRecipe(base))).catch(error => { this.vm = null; throw error; });
    return this.vm;
  }
  private async build(tag: string, recipe: Parameters<typeof buildImage>[1]): Promise<string> {
    if (await imageExists(tag)) return tag;
    this.log(`building ${tag}`);
    await buildImage(tag, recipe, join(this.dataDir, "computers", "build.log"));
    const keep = [this.tag("container"), this.tag("vm")];
    void pruneImages(keep).then(removed => { if (removed.length) this.log(`removed ${removed.join(", ")}`); }).catch(() => {});
    return tag;
  }
}

/** Whether this machine can run VM sandboxes (A85), learned by running a trial VM from the sandbox image when first
 * asked, and again when asked to check; meanwhile `checking`. */
export class VmSupportCheck {
  private known: VmSupport = { state: "unknown" };
  private running: Promise<VmSupport> | null = null;
  constructor(private readonly images: ComputerImages, private readonly log: (text: string) => void) {}
  get current(): VmSupport { return this.known; }
  /** The last answer, checking first when there is none yet or `again`. */
  check(again = false): Promise<VmSupport> {
    if (this.running) return this.running;
    if (!again && this.known.state !== "unknown") return Promise.resolve(this.known);
    this.known = { state: "checking" };
    this.running = (async (): Promise<VmSupport> => {
      try {
        const problem = await vmProblem(await this.images.ready("container"));
        if (problem) this.log(`VM sandboxes can't be used (${problem.reason}): ${problem.detail}`);
        return problem ? { state: "unavailable", ...problem } : { state: "available" };
      } catch (error) { return { state: "unavailable", reason: "failed", detail: (error as Error).message }; }
    })().then(answer => { this.known = answer; return answer; }).finally(() => { this.running = null; });
    return this.running;
  }
}
