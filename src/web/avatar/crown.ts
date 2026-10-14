import type * as Three from "three";

type THREE = typeof Three;
const POINTS = 5, BAND = 0.08, TALL = 0.15, RADIUS = 0.2, HEIGHT = BAND + TALL;
/** Where the crown hovers over the head, its tip towards you, how fast it turns and bobs. */
const HOVER = 0.76, TIP = 0.22, SPIN = 1.1, BOB = 0.02, REST_SPIN = 0.3;

/** The agent Bot's crown (A48, fish m858/m862): a small gold ring crown, five points with a pearl on each, red and
 * blue stones round the band. It hovers over the middle of the head, level whatever the head does, turning slowly
 * and bobbing; still avatars and reduced motion hold it at one angle. */
export class Crown {
  readonly root: Three.Group;
  private readonly spin: Three.Group;
  readonly disposables: { dispose(): void }[] = [];
  constructor(THREE: THREE) {
    const keep = <T extends { dispose(): void }>(item: T) => { this.disposables.push(item); return item; };
    this.root = new THREE.Group(); this.root.rotation.x = TIP; this.root.visible = false;
    this.spin = new THREE.Group(); this.root.add(this.spin);
    // An open band whose top edge rises to the points.
    const band = keep(new THREE.CylinderGeometry(RADIUS * 1.12, RADIUS, HEIGHT, POINTS * 16, 1, true)), position = band.attributes.position!;
    for (let i = 0; i < position.count; i++) if (position.getY(i) > 0) {
      const phase = ((Math.atan2(position.getX(i), position.getZ(i)) / (2 * Math.PI) * POINTS) % 1 + 1) % 1;
      position.setY(i, -HEIGHT / 2 + BAND + TALL * (1 - Math.abs(phase - 0.5) * 2));
    }
    band.computeVertexNormals();
    const gold = keep(new THREE.MeshStandardMaterial({ color: 0xf2b830, roughness: 0.35, metalness: 0.25, side: THREE.DoubleSide }));
    const ring = new THREE.Mesh(band, gold); ring.castShadow = true; this.spin.add(ring);
    const pearl = keep(new THREE.MeshStandardMaterial({ color: 0xfff6dc, roughness: 0.3 })), ball = keep(new THREE.SphereGeometry(0.038, 12, 10));
    const stones = [0xe0455a, 0x3d7be0].map(color => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.25 }))), stone = keep(new THREE.SphereGeometry(0.036, 12, 10));
    for (let k = 0; k < POINTS; k++) {
      const top = ((k + 0.5) / POINTS) * 2 * Math.PI, on = new THREE.Mesh(ball, pearl); on.castShadow = true;
      on.position.set(Math.sin(top) * RADIUS * 1.12, HEIGHT / 2, Math.cos(top) * RADIUS * 1.12); this.spin.add(on);
      const angle = (k / POINTS) * 2 * Math.PI, gem = new THREE.Mesh(stone, stones[k % 2]!);
      gem.scale.z = 0.5; gem.rotation.y = angle; gem.position.set(Math.sin(angle) * RADIUS * 1.04, -HEIGHT / 2 + BAND / 2, Math.cos(angle) * RADIUS * 1.04); this.spin.add(gem);
    }
  }
  /** Places the crown over a head at `headY`, turned back against the body's `yaw` so it stays level and centred on
   * screen; `seconds` drives the turn and bob, or none when still. It rises with the head only a little (a yawn or a
   * stretch lifts the head), so it stays inside the picture. */
  place(headY: number, yaw: number, seconds: number, still: boolean) {
    this.root.position.set(0, HOVER + Math.min(headY, 0.02) + (still ? 0 : Math.sin(seconds * 1.6) * BOB), 0);
    this.root.rotation.y = -yaw; this.spin.rotation.y = still ? REST_SPIN : seconds * SPIN;
  }
}
