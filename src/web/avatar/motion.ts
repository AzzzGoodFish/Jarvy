import { FACE, type Face } from "./face";
import { faceOf } from "./pose";
import type { BotMood } from "../../contract/models";

/** What the body does, from the Bot's status. The live turn adds actions by fact: read (eyes run along a line), turn
 * (faces you to talk), ask (head tilted, watching you), yawn (compacting), stretch (a long turn ended), groom.
 * mood is separate and only changes the face. */
export type FigureMotion = "sleep" | "idle" | "think" | "work" | "busy" | "read" | "turn" | "ask" | "yawn" | "stretch" | "groom";
/** faceX: which way the figure turns — +1 right, −1 left, 0 straight at you. lookX/lookY: where the pointer is, −1..1, or
 * 0 when unknown. fast: tool calls move quicker than text. reduced: prefers-reduced-motion keeps only poses and blinks. */
export interface FigureInput { motion: FigureMotion; mood: BotMood; lookX: number; lookY: number; fast?: boolean; reduced?: boolean; faceX?: number; }

/** The marks a motion shows beside the head (never on it), so they can follow the theme: asleep, struggling, asking,
 * and pleased with a long turn. */
export const MARKS: Partial<Record<FigureMotion, "zz" | "sweat" | "ask" | "sparkle">> = { sleep: "zz", busy: "sweat", ask: "ask", stretch: "sparkle" };

/** Each motion's face, from the design study's beats; the mood's face shows through wherever a motion leaves it alone. */
const POSES: Partial<Record<FigureMotion, Partial<Face>>> = {
  sleep: { kind: 4, earL: .36, earR: .36, look: [0, -.02] },
  think: { lid: .16, earL: .16, earR: .46 },
  work: { open: .55, earL: .14, earR: .14 },
  busy: { kind: 1, mouth: 5, earL: .5, earR: .5 },
  read: { lid: .34 },
  turn: { mouth: 2, mouthOpen: .8, earL: .10, earR: .10 },
  ask: { eyeScale: 1.08, earL: .12, earR: .38 },
  yawn: { kind: 4, mouth: 5, earL: .42, earR: .42 },
  stretch: { kind: 2, mouth: 2, mouthOpen: .8, blush: .8, earL: .06, earR: .06 },
  groom: { kind: 4 },
};
/** How far the head turns towards the middle of the chat, per motion; it meets you to talk. */
const TURN = { rest: .2, turn: .02, ask: .08, read: .12 };

const TAU = Math.PI * 2;
/** How fast a value chases its target per frame: higher is snappier. */
const chase = (from: number, to: number, rate: number) => from + (to - from) * rate;

/** A damped spring for the squash, so every landing and every step leaves a visible wobble that settles on its own. */
class Spring {
  private x = 0; private v = 0; private last = 0;
  kick(amount: number) { this.v += amount; }
  step(now: number) {
    const dt = this.last ? Math.min(.05, Math.max(0, (now - this.last) / 1000)) : 0; this.last = now;
    const k = 180, c = 9.5;
    this.v += (-k * this.x - c * this.v) * dt; this.x += this.v * dt;
    return this.x;
  }
}

/** The live figure's motion: the mood's face, moved by what the Bot is doing. Every state is a handful of numbers on the
 * same face, so a turn cannot drift out of the character the way a second drawing would. */
export class Rig {
  private readonly squash = new Spring();
  private start = 0; private motion: FigureMotion | null = null; private motionAt = 0;
  private blinkAt = 1400; private blinkStart = -1e9;
  private lookX = 0; private lookY = 0; private yaw = 0; private lift = 0; private tilt = 0;

  /** Runs one frame and returns the face to draw. */
  frame(now: number, input: FigureInput): Face {
    const m = input.motion, still = !!input.reduced, sleep = m === "sleep";
    const faceX = input.faceX ?? 0;
    const turn = (m === "turn" || m === "ask" || m === "read" ? TURN[m] : TURN.rest) * faceX;
    if (!this.start) { this.start = now; this.yaw = turn; } // the first frame starts in place, already turned
    if (m !== this.motion) {
      // Each change of motion lands with a small bounce.
      if (this.motion && !still) this.squash.kick(sleep ? -.4 : .6);
      this.motion = m; this.motionAt = now;
    }
    const t = (now - this.start) / 1000, since = (now - this.motionAt) / 1000;
    const target: Face = { ...faceOf(input.mood), ...POSES[m] };
    const wave = (speed: number, amount: number) => still ? 0 : Math.sin(t * speed) * amount;
    const dizzy = !sleep && input.mood === "dizzy";

    // The pointer pulls the face a little everywhere except while dizzy, more when the figure is idle.
    const watch = m === "idle" ? 1 : sleep ? .25 : .45;
    this.lookX = chase(this.lookX, (dizzy ? 0 : input.lookX * watch) * .055, .18);
    this.lookY = chase(this.lookY, (dizzy ? 0 : input.lookY * watch) * .045, .15);
    this.yaw = chase(this.yaw, turn, .07);

    // Breathing is always there; asleep it is slower and deeper, and the body settles a little flatter.
    let squash = (sleep ? 1.05 : 1) + (still ? 0 : Math.sin(TAU * t / (sleep ? 4.4 : 3.4)) * (sleep ? .014 : .008));
    let lift = 0, tilt = target.tilt;
    let look: [number, number] = target.look;
    if (m === "think") {
      look = [wave(.9, .045) + .03, .04]; tilt += .06 + wave(1.3, .03);
    } else if (m === "work" || m === "busy") {
      // A small, soft bounce and eyes moving over what it works on. Quick, but a fraction of a head wide: a big fast
      // swing reads as the whole figure shaking rather than as typing.
      const fast = m === "busy" || input.fast;
      const b = still ? 0 : Math.abs(Math.sin(TAU * t * (fast ? 1.9 : 1.5)));
      squash += .032 * (1 - b); lift = .013 * b;
      look = fast ? [wave(6.5, .012) + wave(2.3, .005), -.03] : [wave(1.9, .02), -.03];
      if (m === "busy") tilt += wave(1.6, .02);
    } else if (m === "read") {
      // The eyes run along a line and jump back to the start of the next.
      look = [still ? 0 : ((since * .55) % 1) * .09 - .045, -.045]; tilt += wave(.7, .02);
    } else if (m === "ask") {
      look = [0, .03]; tilt += .14 + wave(1.1, .03);
    } else if (m === "yawn") {
      // Squeezed for 1.8 s every 3.2 s, like a yawn.
      const y = still ? 0 : Math.sin(Math.PI * Math.min(1, (since % 3.2) / 1.8));
      squash += .05 * y; lift = .02 * y;
    } else if (m === "stretch") {
      const s = still ? 0 : Math.sin(Math.PI * Math.min(1, (since % 3.6) / 1.8));
      squash -= .04 * s; lift = .03 * s;
    } else if (m === "groom") {
      tilt -= .1; look = [.04, -.03];
    }
    this.lift = chase(this.lift, lift, .2);
    this.tilt = chase(this.tilt, tilt, .2);

    // Blinking, unless the eyes are already closed or changed for another reason.
    if (target.kind === 0 && target.open > .5 && now - this.start > this.blinkAt && now - this.blinkStart > 400) {
      this.blinkStart = now; this.blinkAt = now - this.start + 2200 + Math.random() * 3200;
    }
    const blink = (now - this.blinkStart) / 160;
    const shut = blink >= 0 && blink <= 1 ? 1 - .94 * Math.sin(Math.PI * blink) : 1;

    return { ...target, open: target.open * shut, squash: squash * target.squash + this.squash.step(now), lift: this.lift, tilt: this.tilt,
      yaw: this.yaw, look: [this.lookX + look[0], this.lookY + look[1]] };
  }

  /** A short wobble, for a run that failed. */
  shake() { this.squash.kick(-2.2); }
}

export { FACE, type Face };
