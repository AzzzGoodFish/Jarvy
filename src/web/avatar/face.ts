/** Every picture of a Bot — the small still avatar and the large live one in a DM — is one model (A76), drawn by this
 * fragment shader: a flattened ball with two cat ears in one saturated colour, a soft light, a rim and a thin outline,
 * and a face of white lines. The face is a set of numbers (eye shape, lids, mouth, ears, squash), so a mood is a face
 * and an action is the same face moving; nothing is drawn by hand at any size, and 22 px and 88 px cannot drift apart. */

/** How the face looks. `look` moves the whole face a little, which is how the eyes follow the pointer; `yaw` turns the
 * head (positive to the viewer's right); `squash` above 1 flattens the body and below 1 makes it taller. */
export interface Face {
  open: number; happy: number; eyeScale: number; kind: number; lid: number; lidTilt: number; smile: number; blush: number;
  mouth: number; mouthOpen: number; earL: number; earR: number; tilt: number; lift: number; squash: number; yaw: number; look: [number, number];
}

/** A resting face: two pill eyes, ears up, nothing else. */
export const FACE: Face = { open: 1, happy: 0, eyeScale: 1, kind: 0, lid: 0, lidTilt: 0, smile: 0, blush: 0, mouth: 0, mouthOpen: 1,
  earL: .22, earR: .22, tilt: 0, lift: 0, squash: 1, yaw: 0, look: [0, 0] };

/** The body all sizes share: a flattened ellipsoid, slightly narrower at the bottom, with the standard ears. */
export const BODY = { body: .85, waist: .10, ears: 1, earSize: 1.1, earX: .30, earY: .26, earW: .16, earH: .32, earBlend: .03,
  earThick: .060, eyeGap: .205, eyeSize: 1.22 };
/** The chosen lighting: a soft light from the upper left and a rim on the far edge, at every size. */
export const LIGHT = { lit: .55, rim: .5 };

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
const FRAG = `
precision highp float;
uniform vec2 uRes, uLook;
uniform vec3 uColor, uInk;
uniform float uSquash, uEarL, uEarR, uOpen, uHappy, uTilt, uLift, uZoom, uShadow, uYaw;
uniform float uEars, uEarSize, uBody, uEyeGap, uEyeSize, uWaist, uEarX, uEarY, uEarW, uEarH, uEarBlend;
uniform float uKind, uEyeScale, uLid, uLidTilt, uSmile, uBlush, uMouth, uMouthOpen, uEarThick;
uniform float uLit, uRim;

float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
float sdEllipsoid(vec3 p, vec3 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
float sdTri(vec2 p, vec2 q){
  p.x = abs(p.x);
  vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0., 1.);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0., 1.), 1.);
  float s = -sign(q.y);
  vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}
float sdPill(vec2 q, float a, float r){ return length(vec2(q.x, q.y - clamp(q.y, -a, a))) - r; }
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
float sdStar5(vec2 p, float r, float rf){
  const vec2 k1 = vec2(.809016994375, -.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2. * max(dot(k1, p), 0.) * k1; p -= 2. * max(dot(k2, p), 0.) * k2;
  p.x = abs(p.x); p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0., 1.);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0., r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float fill(float d){ return 1. - smoothstep(-.0035, .0035, d); }

// An ear: a fin standing on the head, thick down the middle and thin at both edges, thinner toward the tip — so from the
// side it is a pointed rhombus, not a slab. Melted in at the base, so it grows out of the ball instead of sitting on it.
float sdEar(vec3 q, float ang){
  q.xy = rot(ang) * q.xy;
  float h = uEarH * uEarSize, w = uEarW * uEarSize, round_ = .030 * uEarSize;
  float d2 = sdTri(q.xy - vec2(0., h), vec2(w, -h));
  float up = clamp((q.y + h * .05) / (h * 1.45), 0., 1.), across = clamp(abs(q.x) / w, 0., 1.);
  float half_ = uEarThick * uEarSize * (1. - .45 * up) * (1. - .55 * across * across);
  vec2 e = vec2(d2, abs(q.z) - half_);
  return min(max(e.x, e.y), 0.) + length(max(e, 0.)) - round_;
}

// Down to body space: lifted, tilted about the bottom edge, then squashed at a constant volume, so a squat ball widens.
vec3 toBody(vec3 p){
  p.y -= uLift;
  p.xz = rot(uYaw) * p.xz;
  float floorY = -.58 * uBody;
  p.y -= floorY; p.xy = rot(uTilt) * p.xy; p.y += floorY;
  float widen = 1. / sqrt(max(uSquash, .55));
  p.x *= widen; p.z *= widen; p.y = (p.y - floorY) * uSquash + floorY;
  return p;
}
float map(vec3 p){
  vec3 b = toBody(p);
  vec3 bp = b;
  bp.x /= (1. + uWaist * clamp(-b.y, 0., 1.));
  float d = sdEllipsoid(bp, vec3(.58, .58 * uBody, .55));
  if (uEars > .5){
    float el = sdEar(bp - vec3(-uEarX, uEarY, -.01), uEarL);
    float er = sdEar(bp - vec3(uEarX, uEarY, -.01), -uEarR);
    d = smin(d, min(el, er), uEarBlend);
  }
  return d;
}
vec3 normal(vec3 p){ vec2 e = vec2(.0015, 0.); return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx))); }
float ao(vec3 p, vec3 n){ float o = 0., s = 1.; for (int i = 1; i <= 5; i++){ float h = .02 + .05 * float(i); o += (h - map(p + n * h)) * s; s *= .7; } return clamp(1. - 1.5 * o, 0., 1.); }

// One eye. 0 pill (with lids, or a smile arc), 1 squeezed chevron, 2 star, 3 spiral, 4 closed in content.
float eye(vec2 q, float side){
  q /= uEyeScale;
  float open = max(uOpen, .10), H = .105 * open, d;
  if (uKind < .5){
    float dPill = sdPill(vec2(q.x, q.y / open), .055, .05) * min(open, 1.);
    // Lids: the top cut slants (inner corner low = cross, high = worried); the bottom cut is a curve (a smiling eye).
    dPill = max(dPill, q.y - (H - 2. * H * uLid + uLidTilt * side * q.x));
    vec2 c = vec2(0., -H - .10 + uSmile * .14);
    dPill = max(dPill, -(length(q - c) - .10));
    vec2 qa = q - vec2(0., -.04);
    float dArc = max(abs(length(qa) - .062 * uEyeSize) - .019, -qa.y + .004);
    d = mix(dPill * uEyeSize, dArc, uHappy);
  } else if (uKind < 1.5){
    vec2 tip = vec2(-side * .045, 0.);
    d = min(sdSeg(q, tip, vec2(side * .04, .062)), sdSeg(q, tip, vec2(side * .04, -.062))) - .02;
  } else if (uKind < 2.5){
    d = sdStar5(q * rot(side * .12), .092, .48) - .012;
  } else if (uKind < 3.5){
    float r = length(q), a = atan(q.y, q.x) * side, k = .036;
    d = max(abs(fract(r / k - a / 6.2831853) - .5) * k - .0095, r - .088);
  } else {
    vec2 qa = q - vec2(0., .035);
    d = max(abs(length(qa) - .062 * uEyeSize) - .019, qa.y + .004);
  }
  return d * uEyeScale;
}

// Every mouth is a white line, the same pen as the eyes: no filled cavity, no tongue.
// 1 cat ω, 2 a smile, 3 an O (a yawn), 4 a short line, 5 wavy (a wry face), 6 a frown
float mouth(vec2 q){
  if (uMouth < .5) return 0.;
  float w = .0145, d = 1.;
  if (uMouth < 1.5){
    float r = .034;
    float a = max(abs(length(q - vec2(-r, .012)) - r) - w, q.y - .012);
    float b = max(abs(length(q - vec2(r, .012)) - r) - w, q.y - .012);
    d = min(a, b);
  } else if (uMouth < 2.5){
    vec2 c = vec2(0., .048 * uMouthOpen);
    float R = .062 * uMouthOpen;
    d = max(abs(length(q - c) - R) - w, max(q.y - c.y + .004, abs(q.x) - R * .92));
  } else if (uMouth < 3.5){
    d = abs(length(q / vec2(.060, .080 * uMouthOpen)) - 1.) * .060 - .018;
  } else if (uMouth < 4.5){
    d = sdSeg(q, vec2(-.032, 0.), vec2(.032, 0.)) - w;
  } else if (uMouth < 5.5){
    d = max(abs(q.y - .011 * sin(q.x * 95.)) - .0125, abs(q.x) - .05);
  } else {
    d = max(abs(length(q - vec2(0., -.05)) - .05) - w, -(q.y + .022));
  }
  return fill(d);
}

// The face is painted on the ball's surface, so it sits on the curve rather than floating in front of it.
vec3 paintFace(vec3 b, vec3 base){
  if (b.z < 0.) return base;
  float ink = 0., blush = 0.;
  for (int i = 0; i < 2; i++){
    float side = i == 0 ? -1. : 1.;
    vec2 q = b.xy - (vec2(side * uEyeGap, .01) + uLook);
    ink = max(ink, fill(eye(q, side)));
    vec2 qb = (b.xy - vec2(side * (uEyeGap + .092), .01 - .142) - uLook * .4) / vec2(.080, .050);
    blush = max(blush, 1. - smoothstep(.75, 1.02, length(qb)));
  }
  base = mix(base, mix(uColor, vec3(1., .56, .72), .86), blush * uBlush);
  base = mix(base, uInk, max(ink, mouth(b.xy - vec2(uLook.x * .7, .01 - .215 + uLook.y * .5))));
  return base;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  vec3 ro = vec3(0., .30, 3.4), ta = vec3(0., -.02, 0.);
  vec3 ww = normalize(ta - ro), uu = normalize(cross(ww, vec3(0., 1., 0.))), vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 2.45 * uZoom * ww);
  float t = 0., near = 9.; bool hit = false;
  for (int i = 0; i < 110; i++){
    float d = map(ro + rd * t);
    near = min(near, d);
    if (d < .0008){ hit = true; break; }
    t += d * .8; if (t > 6.) break;
  }
  vec4 col = vec4(0.);
  float tf = (-.585 - ro.y) / rd.y;
  if (tf > 0. && uShadow > 0.){
    vec3 g = ro + rd * tf;
    float s = exp(-pow(length(vec2(g.x / .95, g.z / .8)) / .58, 2.) * 2.0);
    col = vec4(0., 0., 0., .20 * s * uShadow);
  }
  if (hit){
    vec3 p = ro + rd * t, n = normal(p);
    vec3 L = normalize(vec3(-.5, .8, .75));
    // One solid colour, deepened toward the bottom edge and in the hollows, then a soft light from the upper left and a
    // rim that catches the far edge — with the outline, that is what makes a flat colour read as a round body.
    vec3 base = uColor * mix(.94, 1., smoothstep(-.62, .30, p.y)) * mix(.90, 1., ao(p, n));
    float lam = clamp((dot(n, L) + .45) / 1.45, 0., 1.);
    vec3 soft = uColor * mix(vec3(.80, .83, .93), vec3(1.), smoothstep(.08, .86, lam)) * mix(.88, 1., ao(p, n));
    base = mix(base, soft, uLit);
    base += uColor * uRim * pow(1. - max(dot(n, -rd), 0.), 3.2) * .55;
    base = paintFace(toBody(p), base);
    // The crease where the ears meet the head turns edge-on when the head turns, and takes the outline with it.
    base = mix(base, uColor * vec3(.55, .57, .65), (1. - smoothstep(.10, .17, max(dot(n, -rd), 0.))) * .85);
    col = vec4(base, 1.);
  }
  if (!hit && near < 9.){
    // The outline is a band of even width just outside the silhouette, so it does not vanish where the surface turns away
    // fast; a near miss inside the band paints the line over the shadow. Its width is a fixed share of the picture, so
    // the DM figure gets a clear edge and a 22 px avatar a hairline, as in the design study.
    float w = .003 * t;
    float edge = 1. - smoothstep(w * .55, w, near);
    if (edge > 0.) col = vec4(mix(col.rgb, uColor * vec3(.55, .57, .65), edge), max(col.a, edge));
  }
  gl_FragColor = vec4(col.rgb * col.a, col.a);
}`;

/** Where the top of the head is in a picture drawn at `zoom`, as fractions of its size, with the head's roll — so
 * something worn there, like the agent's crown, moves with the body. */
export function crownAt(face: Face, zoom: number) {
  const k = 2.45 * zoom / 3.4, height = .92, top = height / face.squash;
  return { x: .5 - top * Math.sin(face.tilt) * k, y: .5 - .39 * zoom / .92 - (top * Math.cos(face.tilt) + face.lift - height) * k,
    scale: zoom / .92, angle: -face.tilt };
}

const hex = (h: number): [number, number, number] => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];

/** The shader decides each pixel with one ray, so a picture drawn at its own size has stair-steps along the silhouette
 * and an outline thinner than a pixel that breaks into dots. The figure is drawn at least this wide instead and halved
 * down to size: each half averages four pixels exactly, in any browser. */
const SHARP = 256;

export interface Figure {
  /** Paints the figure into the top left `pixels` square of `target`, which the caller has cleared. */
  paint(target: CanvasRenderingContext2D, pixels: number, color: number, face: Face, options?: { shadow?: boolean; zoom?: number }): void;
  /** Gives the WebGL context back at once, rather than when it is collected: browsers keep only a few. */
  dispose(): void;
}

/** One WebGL figure on its own canvas, painted at any size: the canvas takes the size of each draw, so one context serves
 * every avatar. Paints are synchronous, so callers can read the target straight after. */
export function makeFigure(): Figure | undefined {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return undefined;
  const shader = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader"); return s; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const u = (name: string) => gl.getUniformLocation(prog, name);
  const ink = hex(0xffffff);
  const halves = [document.createElement("canvas"), document.createElement("canvas")];
  const draw = (pixels: number, color: number, face: Face, shadow: boolean, zoom: number) => {
    if (canvas.width !== pixels) canvas.width = canvas.height = pixels;
    gl.viewport(0, 0, pixels, pixels); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u("uRes"), pixels, pixels); gl.uniform3fv(u("uColor"), hex(color)); gl.uniform3fv(u("uInk"), ink);
    gl.uniform2fv(u("uLook"), face.look);
    for (const [name, value] of [["uSquash", face.squash], ["uEarL", face.earL], ["uEarR", face.earR], ["uOpen", face.open],
      ["uHappy", face.happy], ["uTilt", face.tilt], ["uLift", face.lift], ["uKind", face.kind], ["uEyeScale", face.eyeScale],
      ["uLid", face.lid], ["uLidTilt", face.lidTilt], ["uSmile", face.smile], ["uBlush", face.blush], ["uMouth", face.mouth],
      ["uMouthOpen", face.mouthOpen], ["uYaw", -face.yaw]] as const) gl.uniform1f(u(name), value);
    for (const [name, value] of Object.entries(BODY)) gl.uniform1f(u("u" + name[0]!.toUpperCase() + name.slice(1)), value);
    gl.uniform1f(u("uZoom"), zoom); gl.uniform1f(u("uShadow"), shadow ? 1 : 0);
    gl.uniform1f(u("uLit"), LIGHT.lit); gl.uniform1f(u("uRim"), LIGHT.rim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  return {
    paint(target, pixels, color, face, { shadow = true, zoom = .9 } = {}) {
      let size = pixels * 2;
      while (size < SHARP) size *= 2;
      draw(size, color, face, shadow, zoom);
      let source = canvas;
      for (let i = 0; size > pixels * 2; size /= 2, i ^= 1) {
        const half = halves[i]!, g = half.getContext("2d")!;
        if (half.width !== size / 2) half.width = half.height = size / 2; else g.clearRect(0, 0, size / 2, size / 2);
        g.drawImage(source, 0, 0, size, size, 0, 0, size / 2, size / 2);
        source = half;
      }
      target.drawImage(source, 0, 0, size, size, 0, 0, pixels, pixels);
    },
    dispose() { gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
