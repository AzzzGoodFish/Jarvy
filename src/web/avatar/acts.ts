import type { Face } from "./face";

/** One act the cat puts on for a moment, over whatever it is doing: a hop, a spin, a sway. `pose` is absolute — the
 * values it leaves out are the figure's own — and `beats` fire once at a moment to kick the springs: a landing, a flop
 * of the ears, a turn of the body. Pose and weight start and end at rest, so an act cut off never jumps. */
export interface Act {
  name: string;
  /** Seconds. */
  dur: number;
  pose: (t: number) => ActPose;
  beats?: [number, (kick: Kick) => void][];
}
/** What an act asks of the figure. `spin` turns the body about itself, in radians (a full circle: a whole spin). */
export interface ActPose extends Partial<Face> { spin?: number; zoom?: number }
export interface Kick { squash(v: number): void; tilt(v: number): void; ears(l: number, r: number): void }

const TAU = Math.PI * 2;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const easeInOut = (u: number) => { u = clamp(u); return u < .5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2; };
const easeOut = (u: number) => 1 - (1 - clamp(u)) ** 3;
const easeOutBack = (u: number) => { u = clamp(u); const c = 1.9; return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; };
/** 0 → 1 over [a, b], held at 1 after. */
const ramp = (t: number, a: number, b: number, ease = easeInOut) => ease((t - a) / (b - a));
/** 0 → 1 → 0: in over [a, b], out over [c, d]. */
const span = (t: number, a: number, b: number, c: number, d: number) => t < c ? ramp(t, a, b) : 1 - ramp(t, c, d);
/** A hop's height: a parabola from `at` for `T` seconds, `h` high. */
const hop = (t: number, at: number, T: number, h: number) => t < at || t > at + T ? 0 : 4 * h * ((t - at) / T) * (1 - (t - at) / T);

/** A damped spring: the landings boing and the ears flop with one of these, and it settles on its own. */
class Spring {
  private x = 0; private v = 0;
  constructor(private readonly k: number, private readonly c: number) {}
  kick(v: number) { this.v += v; }
  step(h: number) { this.v += (-this.k * this.x - this.c * this.v) * h; this.x += this.v * h; return this.x; }
  get value() { return this.x; }
}

/** The acts, from the study in A86, named by what they do. The first ones play on their own now and then (`IDLE`); the
 * rest answer something that happened. */
export const ACTS = {
  hop: { name: "hop", dur: 2.0,
    pose: t => ({ squash: 1 + .22 * span(t, 0, .14, .16, .22), lift: hop(t, .2, .46, .3),
      lid: .22 * span(t, 0, .12, .16, .22), eyeScale: 1 + .08 * span(t, .2, .3, .55, .7), mouth: t > .2 && t < .9 ? 2 : 0, mouthOpen: .6 }),
    beats: [[.66, k => k.squash(2.4)]] },
  spin: { name: "spin", dur: 2.8,
    pose: t => {
      const up = t < 1.5 ? ramp(t, .1, .55, easeOutBack) : 1 - ramp(t, 1.5, 1.75);
      const dizzy = t > 1.6 && t < 2.6 ? Math.sin(TAU * (t - 1.6) * 1.4) * .05 * (1 - ramp(t, 1.9, 2.6)) : 0;
      return { spin: TAU * easeInOut(ramp(t, .55, 1.5)), lift: .03 * up, squash: 1 - .13 * up, tilt: dizzy, kind: t > 1.65 && t < 2.35 ? 3 : 0,
        eyeScale: 1 + .08 * up, mouth: t > .55 && t < 1.6 ? 2 : 0, mouthOpen: .8, earL: lerp(.22, .1, clamp(up)), earR: lerp(.22, .1, clamp(up)) };
    },
    beats: [[1.55, k => { k.squash(1.5); k.ears(1.5, 1.5); }]] },
  hopSpin: { name: "hopSpin", dur: 2.9,
    pose: t => ({ spin: TAU * easeInOut(ramp(t, .55, 1.35)), lift: hop(t, .55, .8, .3), squash: 1 + .2 * ramp(t, .1, .45),
      lid: .2 * span(t, .1, .3, .45, .6), eyeScale: 1 + .1 * (t > .6 && t < 1.4 ? 1 : 0), mouth: t > .6 && t < 1.5 ? 2 : 0, mouthOpen: .75,
      blush: .3 * clamp(ramp(t, .45, .6) * (t < .95 ? 1 : 0)) }),
    beats: [[1.36, k => { k.squash(1.6); k.tilt(1.0); }]] },
  joy: { name: "joy", dur: 2.3,
    pose: t => {
      const hops = [.1, .52, .94], lean = [.1, -.1, 0];
      let lift = 0, tilt = 0;
      hops.forEach((at, i) => { lift += hop(t, at, .3, .13); if (t > at - .1) tilt = lerp(i ? lean[i - 1]! : 0, lean[i]!, ramp(t, at - .1, at + .12, easeOutBack)); });
      const on = span(t, 0, .12, 1.7, 1.95);
      return { lift, tilt: tilt * (1 - ramp(t, 1.3, 1.6)), happy: on, blush: on, mouth: on > .5 ? 2 : 0, mouthOpen: .95,
        earL: lerp(.22, .12, on), earR: lerp(.22, .12, on) };
    },
    beats: [[.4, k => k.squash(1.5)], [.82, k => k.squash(1.5)], [1.24, k => k.squash(1.8)]] },
  sway: { name: "sway", dur: 3.8,
    pose: t => {
      const on = span(t, .15, .7, 3.1, 3.55), u = clamp((t - .3) / 3.0);
      // The pace builds and eases: the turns at each end are slow, the middle a little quicker.
      const sway = Math.sin(TAU * (1.6 * u + .35 * (u - Math.sin(TAU * u) / TAU))) * on;
      return { tilt: .115 * sway, look: [.014 * sway, -.004 * on], mouth: on > .5 ? 1 : 0, lid: .12 * on, blush: .32 * on,
        earL: lerp(.22, .16, on), earR: lerp(.22, .16, on) };
    } },
  flick: { name: "flick", dur: 1.8,
    pose: t => ({ look: [.035 * span(t, .05, .2, 1.1, 1.4), .012 * span(t, .05, .2, 1.1, 1.4)] }),
    beats: [[.2, k => k.ears(0, -4.2)], [.52, k => k.ears(0, -3.6)]] },
  tilt: { name: "tilt", dur: 2.4,
    pose: t => {
      const on = t < 1.6 ? ramp(t, .05, .45, easeOutBack) : 1 - ramp(t, 1.6, 1.95);
      return { tilt: .17 * on, earR: lerp(.22, .03, clamp(on)), earL: lerp(.22, .42, clamp(on)), eyeScale: 1 + .1 * clamp(on), look: [0, .03 * clamp(on)] };
    },
    beats: [[1.95, k => k.tilt(-.9)]] },
  look: { name: "look", dur: 3.0,
    pose: t => {
      const yaw = t < .9 ? -.42 * ramp(t, .1, .4, easeOut) : t < 1.9 ? lerp(-.42, .42, ramp(t, .95, 1.3)) : .42 * (1 - ramp(t, 2.0, 2.35));
      const eyes = t < .85 ? -ramp(t, 0, .1) : t < 1.85 ? lerp(-1, 1, ramp(t, .85, .95)) : 1 - ramp(t, 1.9, 2.0);
      return { yaw, look: [.04 * eyes, .01] };
    },
    beats: [[.08, k => k.squash(.6)], [.92, k => k.squash(.6)], [1.95, k => k.squash(.5)]] },
  stretch: { name: "stretch", dur: 3.0,
    pose: t => {
      const up = t < 1.55 ? ramp(t, 0, 1.0) : 0, eyes = span(t, .15, .35, 1.5, 1.6);
      return { squash: 1 - .2 * up, lift: .03 * up, kind: eyes > .5 ? 4 : 0, mouth: t > .3 && t < 1.6 ? 1 : 0,
        earL: lerp(.22, .03, up), earR: lerp(.22, .03, up), tilt: .03 * Math.sin(TAU * t * .9) * up, happy: span(t, 1.6, 1.7, 2.5, 2.8) };
    },
    beats: [[1.56, k => { k.squash(2.2); k.ears(2, 2); }]] },
  doze: { name: "doze", dur: 4.2,
    pose: t => {
      const doze = t < 2.4 ? ramp(t, .1, 2.0) : 0, nod = doze * Math.max(0, Math.sin(TAU * t * .8));
      const wide = span(t, 2.4, 2.5, 2.9, 3.3), blink = (c: number) => .9 * Math.max(0, 1 - Math.abs(t - c) / .07);
      return { open: Math.max(.08, 1 - .88 * doze - blink(3.45) - blink(3.7)), lid: .2 * doze, tilt: .08 * doze + .03 * nod,
        lift: -.012 * doze - .012 * nod + hop(t, 2.42, .22, .07), squash: 1 + .05 * doze, earL: .22 + .2 * doze, earR: .22 + .2 * doze, eyeScale: 1 + .16 * wide };
    },
    beats: [[2.42, k => { k.ears(-3.5, -3.5); k.tilt(-1.2); }], [2.64, k => k.squash(1.2)]] },
  poke: { name: "poke", dur: 2.4,
    pose: t => {
      const squeeze = span(t, .14, .16, .42, .5), shy = span(t, .45, .6, 1.5, 1.9);
      return { kind: squeeze > .5 ? 1 : 0, blush: shy * .9, happy: shy * .7, mouth: shy > .3 ? 2 : 0, mouthOpen: .7 };
    },
    beats: [[.15, k => { k.squash(2.4); k.tilt(-2.4); k.ears(2.6, 2.6); }]] },
  listen: { name: "listen", dur: 2.2,
    pose: t => {
      const on = span(t, .08, .2, 1.6, 1.9);
      return { earL: lerp(.22, .05, on), earR: lerp(.22, .05, on), eyeScale: 1 + .12 * on, lift: hop(t, .12, .2, .06), look: [-.02 * on, -.045 * on] };
    },
    beats: [[.1, k => k.ears(-3, -3)], [.32, k => k.squash(1)]] },
  dance: { name: "dance", dur: 3.4,
    pose: t => {
      const beat = .36, n = Math.floor(t / beat), u = (t % beat) / beat, on = span(t, 0, .2, 2.7, 3.0);
      const from = n === 0 ? 0 : (n % 2 ? .13 : -.13), to = n % 2 ? -.13 : .13;
      return { tilt: lerp(from, to, easeOutBack(u * 1.4)) * on, lift: t < 2.6 ? hop(u, .05, .9, .035) : 0, happy: on, blush: on * .8,
        mouth: on > .5 ? 2 : 0, mouthOpen: .9 };
    },
    beats: Array.from({ length: 7 }, (_, i) => [i * .36 + .02, (k: Kick) => k.squash(.9)] as [number, (k: Kick) => void]) },
  puff: { name: "puff", dur: 2.6,
    pose: t => {
      const puff = t < 1.4 ? ramp(t, .05, .6, easeOutBack) : 1 - ramp(t, 1.4, 1.52), swell = clamp(puff);
      return { zoom: 1 + .13 * puff, squash: 1 - .04 * puff, blush: .9 * swell, eyeScale: 1 - .06 * swell,
        mouth: t > 1.4 && t < 1.8 ? 3 : 0, mouthOpen: .55, lift: hop(t, 1.45, .2, .05) };
    },
    beats: [[1.47, k => { k.squash(1.8); k.ears(1.5, 1.5); }]] },
  /** Put down after being carried: the squash as it meets the ground (the drop itself is `Persona`'s hold easing out),
   * and the wobble that settles it. */
  land: { name: "land", dur: .8,
    pose: t => ({ kind: t > .16 && t < .34 ? 1 : 0, squash: 1 - .05 * span(t, .16, .24, .4, .75) }),
    beats: [[.18, k => { k.squash(1.6); k.tilt(1.6); }]] },
} as const satisfies Record<string, Act>;

export type ActName = keyof typeof ACTS;

/** What an idle moment may pick, and how likely each is: the small ones. Asleep it keeps to what a sleeping cat does —
 * an ear, a slow sway — and the doze covers the rest. */
const IDLE: [ActName, number][] = [["flick", 3], ["tilt", 3], ["look", 2], ["sway", 2], ["stretch", 2], ["spin", 1]];
const ASLEEP: [ActName, number][] = [["flick", 3], ["sway", 3]];
/** Idle acts come this far apart, plus a random part, in seconds. */
const GAP = 8, SPREAD = 12;
/** Nothing at all for this long, and an awake cat at rest dozes off. */
const QUIET = 150;
/** After the doze it wakes for a while before settling again. */
const AWAKE = 45_000;
/** How often an idle act is the surprise instead. */
const SURPRISE = 1 / 8;

/** The cat's acts, laid over whatever the figure is doing (A86). One at a time, blended in over a tenth of a second and
 * out again, with springs that outlive it — a landing boings, the ears flop a beat later. Between them it does the small
 * idle ones now and then, and dozes after a long quiet. The figure's own motion (breathing, blinking, working) is the
 * Rig's; this only adds to it. */
export class Persona {
  private act: Act | null = null; private name: ActName | null = null; private at = 0; private beat = 0;
  private last = 0; private weight = 0; private carried = false;
  private readonly squash = new Spring(220, 11);
  private readonly roll = new Spring(55, 2.6);
  private readonly earL = new Spring(260, 9);
  private readonly earR = new Spring(260, 9);
  private lift = 0; private vy = 0; private tilt = 0; private turn = 0; private vTilt = 0; private vTurn = 0; private quiet = 0;
  private next = 0; private lastAct: ActName | null = null;
  private blink = -1e9; private blinkAt = 0;
  /** How much the cat is held up: 1 while carried, easing to 0 after it is put down, so the fall takes a moment. */
  private hold = 0;

  /** The act under way, or null. */
  get playing(): string | null { return this.name; }

  /** Plays an act from its start, replacing one under way; nothing while the cat is carried. `weak` is for an act that
   * answers a hint of its own (the wind-up when a turn starts), which must not cut off one just begun for a real event
   * (you speaking, a turn finishing) — the two often land in the same frame. */
  play(name: ActName, now: number, weak = false) {
    if (this.carried || (weak && this.act && (now - this.at) / 1000 < .8)) return;
    this.act = ACTS[name]; this.name = name; this.at = now; this.beat = 0; this.lastAct = name;
  }
  /** Picked up, the cat hangs and sways; put down, it lands with a squash and wobbles. */
  carry(up: boolean, now: number) {
    if (up === this.carried) return;
    this.carried = up;
    if (up) { this.act = null; this.name = null; this.at = now; }
    else { this.act = ACTS.land; this.name = "land"; this.at = now; this.beat = 0; }
  }
  /** The frame's beat: while the cat is at rest, an idle act now and then; a long rest with nothing else happening, the
   * doze. Nothing at all while it works — that is the Rig's to show. */
  idle(now: number, ms: number, busy: boolean, asleep = false) {
    this.quiet = busy ? 0 : this.quiet + ms;
    // The first one comes a while after the chat opens, not the instant it does.
    if (!this.next) { this.next = now + (GAP + Math.random() * SPREAD) * 1000; return; }
    if (busy || this.act || this.carried || now < this.next) return;
    // Its own beat never wakes the doze: only a long rest with no act of its own at all.
    if (!asleep && this.quiet > QUIET * 1000) { this.next = now + AWAKE; this.quiet = 0; this.play("doze", now); return; }
    // A sleeping cat, or one that just dozed, keeps to the few that read asleep.
    const pool = (asleep || this.lastAct === "doze" ? ASLEEP : IDLE).filter(([name]) => name !== this.lastAct), total = pool.reduce((sum, [, weight]) => sum + weight, 0);
    let pick = Math.random() * total, name: ActName = pool[0]![0];
    for (const [candidate, weight] of pool) { pick -= weight; if (pick <= 0) { name = candidate; break; } }
    this.next = now + (GAP + Math.random() * SPREAD) * 1000;
    // The surprise is for an awake cat: asleep it has nothing to be surprised by.
    this.play(!asleep && Math.random() < SURPRISE ? "puff" : name, now);
  }
  /** The figure's face with the act on it, and how much the act swells it (1 when it doesn't). */
  apply(face: Face, now: number): { face: Face; zoom: number } {
    const dt = this.last ? Math.min(.05, Math.max(0, (now - this.last) / 1000)) : 0;
    this.last = now;
    const local = (now - this.at) / 1000;
    if (this.act && !this.carried && local > this.act.dur) { this.act = null; this.name = null; }
    const act = this.act;
    // In over a tenth of a second and out over the last fifth, so a cut act never jumps; the shape of the face (eyes,
    // mouth, blush) has no blend in the shader, so it switches at half way. The landing starts at full weight — the cat
    // comes down from where it was held — and only fades out; it is the hold, not the act, that brings it down.
    this.weight = this.carried ? 1 : act ? (act === ACTS.land ? 1 : clamp(local / .1)) * clamp((act.dur - local) / .18)
      : Math.max(0, this.weight - dt / .18);
    // Put down, it drops: the hold eases out over about a fifth of a second, and the landing's squash meets the ground.
    this.hold = this.carried ? Math.min(1, this.hold + dt / .12) : Math.max(0, this.hold - dt / .2);
    const w = this.weight;
    const pose: ActPose = this.carried
      ? { squash: .8, tilt: .13 * Math.sin(TAU * 1.1 * local), eyeScale: 1.1, mouth: 1 }
      : act ? act.pose(local) : {};
    if (act && !this.carried) for (const [at, kick] of act.beats ?? []) {
      if (local < at || this.beat > at) continue;
      this.beat = at + 1;
      kick({ squash: v => this.squash.kick(v), tilt: v => this.roll.kick(v), ears: (l, r) => { this.earL.kick(l); this.earR.kick(r); } });
    }
    // A hop pulls the ears with it as it starts and as it stops — that lag is what makes it look alive.
    const lift = (pose.lift ?? 0) * w + .22 * this.hold, vy = dt ? (lift - this.lift) / dt : 0, dvy = vy - this.vy;
    this.lift = lift; this.vy = vy;
    this.earL.kick(1.4 * dvy); this.earR.kick(1.4 * dvy);
    const n = 4, h = dt / n;
    for (let i = 0; i < n; i++) { this.squash.step(h); this.roll.step(h); this.earL.step(h); this.earR.step(h); }
    const tilt = (pose.tilt ?? 0) * w + this.roll.value, turn = (pose.spin ?? 0) * w;
    const tiltV = dt ? (tilt - this.tilt) / dt : 0, turnV = dt ? (turn - this.turn) / dt : 0;
    const dTilt = tiltV - this.vTilt, dTurn = turnV - this.vTurn;
    this.tilt = tilt; this.vTilt = tiltV; this.turn = turn; this.vTurn = turnV;
    // A turn of the body leaves the ears behind: the side it turns from swings out.
    this.earL.kick(-.5 * dTilt - .4 * dTurn); this.earR.kick(.5 * dTilt + .4 * dTurn);
    // The pose is blended into what the figure asked for, not written over it: twice the breathing, none of it lost.
    // Absolute values a pose sets are blended into what the figure asked for, never written over it: an act that is not
    // playing (w = 0) leaves the figure exactly as the Rig drew it. Offsets — the springs, the roll, the spin — add.
    const own = face.squash;
    const blend = <K extends keyof Face>(key: K, value: number | undefined) => { if (value !== undefined) (face[key] as number) = lerp(face[key] as number, value, w); };
    blend("eyeScale", pose.eyeScale);
    blend("lid", pose.lid); blend("open", pose.open); blend("blush", pose.blush); blend("mouthOpen", pose.mouthOpen);
    blend("earL", pose.earL); blend("earR", pose.earR);
    blend("spin", pose.spin === undefined ? undefined : face.spin + pose.spin);
    blend("yaw", pose.yaw === undefined ? undefined : face.yaw + pose.yaw);
    if (pose.look) face.look = [lerp(face.look[0], pose.look[0], w), lerp(face.look[1], pose.look[1], w)];
    if (w > .5) for (const key of ["kind", "happy", "mouth"] as const) { const value = pose[key]; if (value !== undefined) (face[key] as number) = value; }
    // The springs add to what was asked for, and the body never flattens past a ball.
    const wanted = pose.squash === undefined ? 1 : pose.squash;
    face.squash = clamp(own * lerp(1, wanted, w) + this.squash.value + .025 * Math.abs(this.roll.value) * w, .82, 1.24);
    // The tilt already carries the act's weight; the roll and the springs ring on after the act has gone. The ears hang
    // as it is carried and lift again as it comes down, without being asked for as a pose.
    face.tilt += tilt;
    face.lift += lift;
    face.earL += this.earL.value + .24 * this.hold; face.earR += this.earR.value + .24 * this.hold;
    // Its own blink, unless the eyes are already shut or shaped otherwise.
    if (face.kind === 0 && face.open > .5 && now >= this.blinkAt && now - this.blink > 400) { this.blink = now; this.blinkAt = now + 2200 + Math.random() * 3200; }
    const blink = (now - this.blink) / 160;
    if (blink >= 0 && blink <= 1) face.open *= 1 - .94 * Math.sin(Math.PI * blink);
    return { face, zoom: pose.zoom ? lerp(1, pose.zoom, w) : 1 };
  }
  /** A short wobble, for a run that failed. */
  shake() { this.squash.kick(-2.2); }
}
