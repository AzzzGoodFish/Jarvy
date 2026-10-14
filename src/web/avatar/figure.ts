import type * as Three from "three";
import type { BotMood } from "./palette";

type THREE = typeof Three;
/** What the body does (from Bot status); mood only changes the eyes. The NPC prototype adds actions by fact: read (holds
 * a page), turn (faces you to talk), ask (head tilted, watching you), yawn (compacting), stretch (a turn ended), groom
 * (licks a paw when idle long). */
export type FigureMotion = "sleep" | "idle" | "think" | "work" | "busy" | "static" | "read" | "turn" | "ask" | "yawn" | "stretch" | "groom";
/** faceX: which way the floating cat turns — +1 to the right (it sits at the left of the chat), −1 to the left (at the
 * right), 0 straight at you (in the middle); without it the cat keeps its resting three-quarter turn to the right.
 * lookX/lookY: where the pointer is, −1..1 (positive = right / below), or 0 when unknown; the pointer always steers the
 * body and the eyes a little, on top of whatever the action is doing (most when the cat is only watching).
 * fast: tool calls tap quicker than text. reduced: prefers-reduced-motion, keeps only poses, blinks and gaze. */
export interface FigureInput { motion: FigureMotion; mood: BotMood; lookX: number; lookY: number; fast?: boolean; reduced?: boolean; faceX?: number; }

const REST_YAW = 0.55, EYE_BIAS = 0.12, EYE_LEAD = 0.6;

function roundedRect(THREE: THREE, w: number, h: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Scene, lights and ground shadow shared by the live avatar and the snapshot renderer.
 * Colour management is off and light intensities are scaled by π so three r186 matches the r128
 * reference study (Bot cat 3D study), which predates both changes. */
export function createStage(THREE: THREE) {
  THREE.ColorManagement.enabled = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x77756d, 0.8 * Math.PI));
  const key = new THREE.DirectionalLight(0xffffff, 0.85 * Math.PI);
  key.position.set(-1.6, 3.6, 1.8); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 10 });
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35 * Math.PI); fill.position.set(2, 1, 4); scene.add(fill);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.78; ground.receiveShadow = true; scene.add(ground);
  return { scene, camera, ground };
}
export function configureRenderer(THREE: THREE, renderer: Three.WebGLRenderer) {
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
}
/** Frames the figure for a viewport of the given aspect (width / height). */
export function frameCamera(camera: Three.PerspectiveCamera, aspect: number, distance = 3.5) {
  camera.aspect = aspect;
  camera.position.set(0, 0.5, Math.max(distance, distance * 1.15 / aspect * 0.9));
  camera.lookAt(0, -0.02, 0); camera.updateProjectionMatrix();
}

/** The cat from the reference study: rounded head, ears, mood eyes, two paws. */
export class CatFigure {
  readonly root: Three.Group;
  private readonly head: Three.Group;
  private readonly eyes: Three.Group;
  private readonly body: Three.MeshStandardMaterial;
  private readonly parts: { group: Three.Group; pill: Three.Mesh; arc: Three.Group; spiral: Three.Mesh }[];
  private readonly paws: Three.Mesh[];
  private readonly paper: Three.Mesh;
  private readonly mouth: Three.Mesh;
  private motion: FigureMotion = "static"; private motionAt = 0;
  private readonly disposables: { dispose(): void }[] = [];
  private shown: BotMood = "normal";
  private yaw = REST_YAW; private pitch = 0; private lookX = 0; private lookY = 0; private drawn = false;
  private blinkAt = 1500; private blinkStart = -1e9; private shakeAt = -1e9; private readonly start = performance.now();
  constructor(THREE: THREE, color: number) {
    const keep = <T extends { dispose(): void }>(item: T) => { this.disposables.push(item); return item; };
    this.body = keep(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 }));
    const ink = keep(new THREE.MeshBasicMaterial({ color: 0x23221f }));
    this.root = new THREE.Group();
    this.head = new THREE.Group(); this.root.add(this.head);
    const headGeometry = keep(new THREE.ExtrudeGeometry(roundedRect(THREE, 1.2, 0.86, 0.2), { depth: 0.5, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.1, bevelSegments: 6, curveSegments: 14 }));
    headGeometry.center();
    const head = new THREE.Mesh(headGeometry, this.body); head.castShadow = true; head.receiveShadow = true; this.head.add(head);
    const earShape = new THREE.Shape(); earShape.moveTo(-0.14, 0); earShape.lineTo(0.14, 0); earShape.lineTo(0, 0.34); earShape.closePath();
    const earGeometry = keep(new THREE.ExtrudeGeometry(earShape, { depth: 0.1, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 3 }));
    earGeometry.translate(0, 0, -0.05);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(earGeometry, this.body); ear.castShadow = true;
      ear.position.set(side * 0.42, 0.44, 0.04); ear.rotation.z = -side * 0.2; this.head.add(ear);
    }
    this.eyes = new THREE.Group(); this.eyes.position.set(EYE_BIAS, 0.04, 0.352); this.head.add(this.eyes);
    const pillGeometry = keep(new THREE.ExtrudeGeometry(roundedRect(THREE, 0.08, 0.22, 0.04), { depth: 0.012, bevelEnabled: false }));
    const arcAngle = Math.PI * 0.85, arcRadius = 0.085;
    const arcGeometry = keep(new THREE.TorusGeometry(arcRadius, 0.024, 8, 24, arcAngle)), capGeometry = keep(new THREE.SphereGeometry(0.024, 10, 8));
    const spiral = Array.from({ length: 91 }, (_, i) => { const q = i / 90, angle = q * Math.PI * 5, radius = 0.012 + q * 0.085; return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0); });
    const spiralGeometry = keep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spiral), 120, 0.012, 6, false));
    this.parts = [-0.17, 0.17].map(x => {
      const group = new THREE.Group(); group.position.x = x; this.eyes.add(group);
      const pill = new THREE.Mesh(pillGeometry, ink); group.add(pill);
      const arc = new THREE.Group(), torus = new THREE.Mesh(arcGeometry, ink); torus.rotation.z = Math.PI / 2 - arcAngle / 2; arc.add(torus);
      for (const angle of [Math.PI / 2 - arcAngle / 2, Math.PI / 2 + arcAngle / 2]) {
        const cap = new THREE.Mesh(capGeometry, ink); cap.position.set(Math.cos(angle) * arcRadius, Math.sin(angle) * arcRadius, 0); arc.add(cap);
      }
      arc.position.set(0, -0.04, 0.02); group.add(arc);
      const spiralMesh = new THREE.Mesh(spiralGeometry, ink); spiralMesh.position.z = 0.014; group.add(spiralMesh);
      return { group, pill, arc, spiral: spiralMesh };
    });
    const pawGeometry = keep(new THREE.SphereGeometry(1, 24, 16));
    this.paws = [-0.42, 0.42].map(x => {
      const paw = new THREE.Mesh(pawGeometry, this.body); paw.castShadow = true; paw.receiveShadow = true;
      paw.scale.set(0.17, 0.1, 0.15); paw.position.set(x, -0.66, 0.22); this.root.add(paw); return paw;
    });
    // A page held while reading, and a mouth that only shows in a yawn.
    this.paper = new THREE.Mesh(keep(new THREE.BoxGeometry(0.62, 0.44, 0.012)), keep(new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.9 })));
    this.paper.position.set(0, -0.36, 0.62); this.paper.rotation.x = -0.55; this.paper.castShadow = true; this.paper.visible = false; this.root.add(this.paper);
    this.mouth = new THREE.Mesh(keep(new THREE.CircleGeometry(0.07, 20)), ink);
    this.mouth.position.set(EYE_BIAS, -0.2, 0.364); this.mouth.visible = false; this.head.add(this.mouth);
    this.root.rotation.y = REST_YAW;
    this.show("normal");
  }
  setColor(color: number) { this.body.color.setHex(color); }
  private show(mood: BotMood) {
    this.shown = mood;
    for (const eye of this.parts) {
      eye.pill.visible = mood === "normal" || mood === "sad" || mood === "angry";
      eye.arc.visible = mood === "happy"; eye.spiral.visible = mood === "dizzy";
    }
  }
  /** Still pose for avatars: resting yaw, no blink, mood eyes and their tilt. */
  pose(mood: BotMood) {
    this.show(mood);
    this.root.rotation.y = REST_YAW; this.head.rotation.set(mood === "sad" ? 0.1 : mood === "angry" ? 0.06 : 0, 0, 0); this.head.position.y = 0;
    this.eyes.position.set(EYE_BIAS, 0.04 - (mood === "sad" ? 0.03 : 0) - (mood === "angry" ? 0.015 : 0), 0.352);
    const tilt = mood === "sad" ? 0.32 : mood === "angry" ? -0.38 : 0;
    this.parts.forEach((eye, i) => { eye.group.scale.y = mood === "angry" ? 0.78 : 1; eye.group.rotation.z = i ? tilt : -tilt; });
    for (const paw of this.paws) { paw.position.y = -0.66; paw.scale.set(0.17, 0.1, 0.15); }
  }
  /** A short head shake (a run failed); plays on the next frames. */
  shake(now: number) { this.shakeAt = now; }
  /** One animation step, based on the study's frame loop plus sleep / think / busy / shake. */
  frame(now: number, input: FigureInput) {
    const t = (now - this.start) / 1000, m = input.motion, still = !!input.reduced;
    if (m !== this.motion) { this.motion = m; this.motionAt = now; }
    const since = (now - this.motionAt) / 1000;
    // Yawn: open and close over 1.8 s, every 3.2 s. Stretch: up and back over 1.8 s, every 3.6 s (a turn's end shows one).
    const yawn = m === "yawn" ? Math.sin(Math.PI * Math.min(1, (since % 3.2) / 1.8)) : 0;
    const stretch = m === "stretch" ? Math.sin(Math.PI * Math.min(1, (since % 3.6) / 1.8)) : 0;
    const sleep = m === "sleep", follow = m === "idle" && this.shown !== "dizzy";
    const dizzy = !sleep && this.shown === "dizzy", sad = this.shown === "sad", angry = this.shown === "angry";
    const wave = (speed: number, amount: number) => still ? 0 : Math.sin(t * speed) * amount;
    // Thinking is head-down like working, only slower (looking up read as frozen).
    const down = m === "work" || m === "think";
    // The resting turn is three-quarters to the right (a positive yaw); the floating cat mirrors it across the chat — to
    // the right at the left edge, to the left at the right edge, straight at you in the middle — and so do the eyes.
    const toward = input.faceX ?? 1;
    const facing = (m === "turn" ? 0.05 : m === "ask" ? 0.14 : m === "read" ? REST_YAW * 0.6 : REST_YAW) * toward;
    // The pointer: full when the cat is only watching (idle), softer while it works or sleeps; never when dizzy.
    const watch = m === "idle" || m === "static" ? 1 : sleep ? 0.25 : 0.45;
    const followX = dizzy ? 0 : input.lookX * 0.22 * watch, followY = dizzy ? 0 : input.lookY * 0.1 * watch;
    const targetYaw = facing + followX + (m === "busy" ? wave(9, 0.12) : 0) + (dizzy ? wave(2.1, 0.1) : 0);
    const targetPitch = (down ? 0.14 : 0) + followY + (sleep ? 0.16 : 0) + (sad ? 0.1 : 0) + (angry ? 0.06 : 0)
      + (m === "read" ? 0.24 + wave(0.7, 0.02) : 0) + (m === "groom" ? 0.1 : 0) - 0.2 * yawn - 0.14 * stretch;
    const targetRoll = (dizzy ? wave(3.2, 0.07) : 0) + (m === "think" ? wave(1.3, 0.025) : 0) + (m === "busy" ? wave(9, 0.05) : 0)
      + (m === "ask" ? 0.24 + wave(1.1, 0.03) : 0) + (m === "groom" ? -0.14 : 0) + (m === "turn" ? wave(2.4, 0.03) : 0);
    // The first frame starts in place, so a cat sitting on the right does not turn round when the page opens.
    const ease = (from: number, to: number, rate: number) => this.drawn ? from + (to - from) * rate : to;
    this.yaw = ease(this.yaw, targetYaw, 0.07); this.pitch = ease(this.pitch, targetPitch, 0.1);
    this.root.rotation.y = this.yaw; this.head.rotation.x = this.pitch;
    this.head.rotation.z += (targetRoll - this.head.rotation.z) * 0.2;
    // Work taps fast (tools faster than text); thinking taps slowly and lightly, eyes drifting across the "desk".
    const tap = still ? 0 : m === "work" ? Math.sin(t * (input.fast ? 20 : 14)) : m === "think" ? Math.sin(t * 4.5) * 0.45 : 0;
    const left = Math.max(0, tap), right = Math.max(0, -tap);
    // Reading, the eyes run along the lines; talking or asking, they meet yours.
    // Eyes: the pointer leads them (most when the cat is only watching), else the action's own drift.
    const glanceX = dizzy ? 0 : input.lookX * (follow ? 0.6 : 0.45 * watch);
    const glanceY = dizzy ? 0 : input.lookY * (follow ? -0.55 : 0.4 * watch);
    const lookX = glanceX || (m === "work" ? (still ? 0 : left > right ? -0.6 : 0.6)
      : m === "think" ? wave(0.9, 0.5) : m === "busy" ? wave(9, 0.5) : m === "read" ? (still ? 0 : ((since * 0.8) % 1) * 1.2 - 0.6) : 0);
    const lookY = glanceY || (down || m === "read" ? -1 : sleep ? -0.3 : 0);
    this.lookX = ease(this.lookX, lookX, 0.2); this.lookY = ease(this.lookY, lookY, 0.15); this.drawn = true;
    const lead = Math.max(-0.2, Math.min(0.2, (targetYaw - this.yaw) * EYE_LEAD));
    this.eyes.position.x = EYE_BIAS * toward + lead + this.lookX * 0.06;
    this.eyes.position.y = 0.04 + this.lookY * 0.09 - (sad ? 0.03 : 0) - (angry ? 0.015 : 0);
    const blinking = !sleep && (this.shown === "normal" || sad || angry);
    if (m !== "static" && blinking && now - this.start > this.blinkAt && now - this.blinkStart > 400) {
      this.blinkStart = now; this.blinkAt = now - this.start + 2200 + Math.random() * 3200;
    }
    // A mood change waits for the middle of a blink, so the eyes swap while closed.
    if (input.mood !== this.shown && now - this.blinkStart > 400) this.blinkStart = now;
    const progress = (now - this.blinkStart) / 160;
    if (input.mood !== this.shown && progress >= 0.5) this.show(input.mood);
    // Asleep the eyes are closed lines whatever the mood; the mood shows again on waking.
    for (const eye of this.parts) {
      eye.pill.visible = sleep || this.shown === "normal" || sad || angry;
      eye.arc.visible = !sleep && this.shown === "happy"; eye.spiral.visible = !sleep && this.shown === "dizzy";
    }
    // Yawning, stretching and grooming, the eyes close.
    const closed = Math.max(yawn, stretch * 0.9, m === "groom" ? 0.9 : 0);
    const squeeze = (sleep ? 0.1 : progress >= 0 && progress <= 1 ? 1 - 0.92 * Math.sin(Math.PI * progress) : 1) * (1 - 0.88 * closed), tilt = sleep ? 0 : sad ? 0.32 : angry ? -0.38 : 0;
    this.parts.forEach((eye, i) => {
      eye.group.scale.y = squeeze * (angry && !sleep ? 0.78 : 1);
      eye.group.rotation.z += ((i ? tilt : -tilt) - eye.group.rotation.z) * 0.15; if (!still) eye.spiral.rotation.z += 0.14;
    });
    this.paws.forEach((paw, i) => {
      const press = i ? right : left, side = i ? 1 : -1;
      // Where each paw goes: holding the page, raised high, one paw at the face (licking) or gesturing while talking.
      const target = m === "read" ? [side * 0.3, -0.44 + wave(0.7, 0.01), 0.6]
        : m === "stretch" ? [side * (0.42 + 0.2 * stretch), -0.66 + 0.62 * stretch, 0.22 - 0.1 * stretch]
        : m === "groom" && i ? [0.2, -0.2 + wave(7, 0.035), 0.5]
        : m === "turn" && i ? [0.4, -0.52 + wave(3, 0.05), 0.32]
        : [side * 0.42, -0.66 - 0.06 * press, 0.22];
      paw.position.x += (target[0]! - paw.position.x) * 0.2; paw.position.y += (target[1]! - paw.position.y) * 0.2; paw.position.z += (target[2]! - paw.position.z) * 0.2;
      paw.scale.set(0.17 * (1 + 0.25 * press), 0.1 * (1 - 0.3 * press), 0.15 * (1 + 0.25 * press));
    });
    this.paper.visible = m === "read";
    this.mouth.visible = yawn > 0.05; this.mouth.position.x = EYE_BIAS * toward + lead; this.mouth.scale.set(0.8 + 0.3 * yawn, 0.2 + 1.3 * yawn, 1);
    this.root.scale.y = 1 + 0.05 * stretch;
    this.head.position.y = (m === "static" ? 0 : sleep ? wave(1.2, 0.02) - 0.02 : wave(2, 0.01)) - 0.03 * (left + right) + 0.04 * yawn + 0.06 * stretch;
    const shaking = (now - this.shakeAt) / 600;
    this.root.position.x = !still && shaking >= 0 && shaking < 1 ? Math.sin(shaking * Math.PI * 6) * 0.06 * (1 - shaking) : 0;
  }
  dispose() { for (const item of this.disposables) item.dispose(); }
}
