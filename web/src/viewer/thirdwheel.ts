// Video layer: plays a tw-pack-v1 RGB + depth + mask video as a 3D relief placed at the video
// camera's pose (see VideoLayer in shared/types.ts).
//
// Pipeline per video frame:
//   1. One THREE.VideoTexture holds the packed frame (raw values; RGB is linearised in-shader).
//   2. A small GPU pre-pass evaluates every grid vertex once: reads depth and mask around it,
//      pulls the silhouette ring onto the person, snaps blurred occlusion ramps (arm over torso)
//      to the nearer layer, smooths 8-bit terracing elsewhere. Result: a (cols+1) x (rows+1)
//      texture of processed inverse depth. A second pre-pass finds, behind every occluder (an
//      arm over the torso, a blender held or standing in front of the person), the person on both
//      sides of it, and stores the depth and colour of the person probably hidden there.
//   3. The grid mesh's vertex shader unprojects that depth with the pinhole intrinsics into the
//      OpenGL camera frame (x right, y up, looking down -Z) and compares neighbouring depths to
//      pass an edge factor.
//   4. The fragment shader takes colour from the RGB band and alpha from the mask band (soft
//      edge). Where the edge factor says a depth jump is near, it rebuilds its own triangle from
//      the processed depths and drops it if the current view sees it stretched: a triangle that
//      bridges an occlusion step lies along the video camera's rays, so it is a sliver from where
//      the video was shot (and fills the crack there) but a rubber sheet from anywhere else.
//
// Back sheet: a second grid at that hidden depth, drawn only where it exists. From the video
// camera it lies exactly behind the occluder; from anywhere else it closes what would otherwise be
// a gap cut through the person (from a standing eye above a camera at table height, a blender in
// front of the cook cuts a column through her torso).
//
// Compositing with the splat world (Spark draws splats in the transparent pass, depth-tested,
// without depth writes):
//   core pass   (opaque queue, before splats): alpha >= cut, writes depth, so splats behind the
//               person are hidden and splats in front of them still blend over.
//   fringe pass (transparent queue, after splats): the soft edge, 0 < alpha < cut, blended.
// While fading (setOpacity < 1 or the view-angle fade) everything goes through the blended pass.

import * as THREE from 'three';
import type { Vec3, VideoLayer } from '../../../shared/types.ts';

export interface VideoLayerHandle {
  object: THREE.Object3D; // add to the scene; already placed at video.cameraPose
  video: HTMLVideoElement; // the source element (owns audio)
  ready: Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number;
  update(dt: number, camera: THREE.Camera): void; // call every frame
  setOpacity(o: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers. The GLSL below mirrors these; tests/thirdwheel.test.ts covers them.

/** Packed frame size for a tw-pack-v1 video whose RGB region is width x height. */
export function packedSize(width: number, height: number): { width: number; height: number } {
  return { width, height: Math.round(height * 1.5) };
}

/** Pixel rectangle [x0, x1) x [y0, y1) in the packed frame, y down from the top row. */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PackLayout {
  texWidth: number;
  texHeight: number;
  rgb: PixelRect;
  depth: PixelRect;
  mask: PixelRect;
}

/**
 * Band rectangles for a decoded packed frame of texWidth x texHeight. Derived from the decoded
 * size rather than the nominal one, so a file that was resized after packing still lines up.
 */
export function packLayout(texWidth: number, texHeight: number): PackLayout {
  const rgbRows = Math.round((texHeight * 2) / 3);
  const half = Math.round(texWidth / 2);
  return {
    texWidth,
    texHeight,
    rgb: { x0: 0, y0: 0, x1: texWidth, y1: rgbRows },
    depth: { x0: 0, y0: rgbRows, x1: half, y1: texHeight },
    mask: { x0: half, y0: rgbRows, x1: texWidth, y1: texHeight },
  };
}

/**
 * Texture coordinate for normalised image position (s, t) (0..1, t down) inside a band. The
 * sample point is clamped `inset` texels inside the band (0.5 = the outermost texel centres), so
 * linear filtering never reads a neighbouring band. The texture is uploaded with flipY = false,
 * so v = 0 is the top row of the frame.
 */
export function bandUv(rect: PixelRect, s: number, t: number, texWidth: number, texHeight: number, inset = 0.5): [number, number] {
  let px = rect.x0 + s * (rect.x1 - rect.x0);
  let py = rect.y0 + t * (rect.y1 - rect.y0);
  px = Math.min(Math.max(px, rect.x0 + inset), rect.x1 - inset);
  py = Math.min(Math.max(py, rect.y0 + inset), rect.y1 - inset);
  return [px / texWidth, py / texHeight];
}

/** Depth in metres from an encoded value v in [0, 1]: 1/d = 1/far + v (1/near - 1/far). */
export function decodeInverseDepth(v: number, near: number, far: number): number {
  return 1 / (1 / far + v * (1 / near - 1 / far));
}

/** Inverse of decodeInverseDepth, clamped to [0, 1]. */
export function encodeInverseDepth(d: number, near: number, far: number): number {
  const v = (1 / d - 1 / far) / (1 / near - 1 / far);
  return Math.min(1, Math.max(0, v));
}

/** Continuous OpenCV pixel coordinate (pixel centres at integers) of normalised image position (s, t). */
export function gridToPixel(s: number, t: number, width: number, height: number): [number, number] {
  return [s * width - 0.5, t * height - 0.5];
}

/**
 * Unproject pixel (x right, y down, OpenCV centres) at z-depth `depth` metres into the OpenGL
 * camera frame: x right, y up, looking down -Z.
 */
export function unprojectPixel(x: number, y: number, depth: number, intr: VideoLayer['intrinsics']): Vec3 {
  return [((x - intr.cx) / intr.fx) * depth, (-(y - intr.cy) / intr.fy) * depth, -depth];
}

/** Grid segments (cols, rows) for an RGB size: longest side = maxSegments, matched to aspect. */
export function gridDims(width: number, height: number, maxSegments = 320): [number, number] {
  if (width >= height) return [maxSegments, Math.max(2, Math.round((maxSegments * height) / width))];
  return [Math.max(2, Math.round((maxSegments * width) / height)), maxSegments];
}

/**
 * Corners (grid vertex offsets) of the triangle containing fractional position (fx, fy) in grid
 * cell (i, j). Matches the index buffer, whose diagonal alternates with the cell parity.
 */
export function cellTriangle(i: number, j: number, fx: number, fy: number): [[number, number], [number, number], [number, number]] {
  if ((i + j) & 1) return fx + fy < 1 ? [[0, 0], [0, 1], [1, 0]] : [[1, 0], [0, 1], [1, 1]];
  return fy > fx ? [[0, 0], [0, 1], [1, 1]] : [[0, 0], [1, 1], [1, 0]];
}

/** 16-bit fixed point split into two 8-bit channels, as the pre-pass stores processed depth. */
export function pack16(u: number): [number, number] {
  const q = Math.round(Math.min(1, Math.max(0, u)) * 65535);
  const hi = Math.floor(q / 256);
  return [hi, q - hi * 256];
}

export function unpack16(hi: number, lo: number): number {
  return (hi * 256 + lo) / 65535;
}

/** Resolve a scene-relative file against the scene directory URL. */
export function resolveSceneFile(baseUrl: string, file: string): string {
  if (/^(https?:|blob:|data:)/.test(file) || file.startsWith('/')) return file;
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return base + file.replace(/^\.\//, '');
}

/** Samples along one search direction from a vertex: index k is (k + 1) steps away. */
export interface SearchLine {
  mask: ArrayLike<number>;
  /** Inverse depth of each sample. */
  inv: ArrayLike<number>;
}

/**
 * Back-sheet search along one direction (mirrors findPerson in the fill pre-pass, which reads each
 * depth two cells further into the person): the first person sample farther than `limit`
 * (inverse depth), averaged with up to two following samples of the same surface.
 */
export function findHiddenAlong(line: SearchLine, limit: number, step = 1): { dist: number; inv: number } | null {
  const n = Math.min(line.mask.length, line.inv.length);
  for (let k = 0; k < n; k++) {
    if (line.mask[k] < 0.5) continue;
    const iq = line.inv[k];
    if (iq > limit) continue;
    let sum = iq, cnt = 1;
    for (let e = 1; e <= 2 && k + e < n; e++) {
      const ir = line.inv[k + e];
      if (line.mask[k + e] < 0.5 || ir > limit || Math.abs(ir - iq) > 0.15 * iq) break;
      sum += ir;
      cnt++;
    }
    return { dist: (k + 1) * step, inv: sum / cnt };
  }
  return null;
}

/**
 * Inverse depth of the person hidden behind a vertex of inverse depth c, from the four search
 * lines (+x, -x, +y, -y), or null when nothing is hidden there (mirrors fillBehind).
 */
export function hiddenBehind(
  c: number,
  lines: [SearchLine, SearchLine, SearchLine, SearchLine],
  t: Pick<typeof TW_TUNING, 'fillOcclusion' | 'fillMaxSpan' | 'fillPair' | 'fillStep'> = TW_TUNING,
): number | null {
  const limit = c / (1 + t.fillOcclusion);
  const f = lines.map((l) => findHiddenAlong(l, limit, t.fillStep));
  const pair = (a: typeof f[number], b: typeof f[number]) =>
    !!a && !!b && a.dist + b.dist <= t.fillMaxSpan && Math.abs(a.inv - b.inv) <= t.fillPair * Math.max(a.inv, b.inv);
  const px = pair(f[0], f[1]) ? 1 : 0;
  const py = pair(f[2], f[3]) ? 1 : 0;
  if (px + py === 0) return null;
  const w = [px, px, py, py].map((p, i) => (p && f[i] ? p / Math.max(f[i]!.dist, 1) : 0));
  const sw = w.reduce((s, v) => s + v, 0);
  return f.reduce((s, h, i) => s + (h ? h.inv * w[i] : 0), 0) / sw;
}

// ---------------------------------------------------------------------------------------------
// Tuning. Values are relative, so they hold for any resolution and metric scale.

export const TW_TUNING = {
  maxGridSegments: 320,
  /** Inset from band borders in texels: half a texel plus a guard against codec deblocking. */
  bandInset: 1.0,
  /**
   * Relative range of inverse depth in a vertex's window above which an occlusion step is assumed
   * and depth snaps to the nearer layer. Body parts vary by a few percent at 1-3 m; an arm in front
   * of a torso, or a pan in front of a belly, jumps by 10% or more.
   */
  splitThreshold: 0.1,
  /** Neighbour jumps below this (relative) cannot form a tear; the exact test is skipped there. */
  edgeFloor: 0.025,
  /** Neighbours within this relative inverse depth are averaged to hide 8-bit terracing. */
  smoothTolerance: 0.025,
  /** Mask value ramp for alpha (soft edge). */
  maskLow: 0.3,
  maskHigh: 0.75,
  /** Alpha at or above which a fragment is drawn opaque in the core pass. */
  coreCut: 0.9,
  /**
   * Stretch = |n . view| / |n . video ray| for a triangle: how much more of it this view sees than
   * the video camera did. Triangles across an occlusion step are dropped once it passes tearLow;
   * triangles touching the silhouette ring (laid flat on the person) once it passes silLow; any
   * other triangle only past anyLow. Real surfaces stay below ~5 even when steep (a forearm
   * pointing at the camera, a pan seen almost edge-on); fins left by small steps reach 10+.
   */
  tearLow: 1.4,
  tearHigh: 1.8,
  /**
   * Triangles across a step, or lying almost along the video ray (|n . ray| < ~0.1), are also
   * dropped outside this cone (degrees) around the video camera's line of sight.
   */
  tearConeInnerDeg: 4,
  tearConeOuterDeg: 9,
  silLow: 3,
  silHigh: 3.8,
  anyLow: 6,
  anyHigh: 7.5,
  /**
   * Back sheet: a vertex with the person on both sides (within fillSteps x fillStep grid cells,
   * left/right or above/below, at most fillMaxSpan cells apart) who are farther than the vertex by
   * more than fillOcclusion (relative inverse depth) is an occluder in front of the person; the
   * back sheet carries the person's depth and colour there. Gaps to the wall (farther than the
   * person) never get one.
   */
  fillSteps: 24,
  fillStep: 2,
  fillOcclusion: 0.12,
  fillMaxSpan: 96,
  /** The two sides of a pair must agree in inverse depth within this fraction. */
  fillPair: 0.25,
  /** Relative step between neighbouring back-sheet vertices above which no triangle joins them. */
  backStep: 0.3,
  /** Back-sheet fragments seen this much more face-on than from the video camera dissolve (dithered). */
  backStretchLow: 4,
  backStretchHigh: 6,
  /** View-angle fade: full opacity up to fadeStart degrees off the video axis, fadeMin at fadeEnd. */
  fadeStartDeg: 80,
  fadeEndDeg: 155,
  fadeMin: 0.3,
};

// ---------------------------------------------------------------------------------------------
// Shaders

const COMMON = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec4 uRgbRect;
uniform vec4 uDepthRect;
uniform vec4 uMaskRect;
uniform float uInset;
uniform vec2 uImageSize;
uniform vec4 uIntrinsics;   // fx, fy, cx, cy
uniform vec2 uInvDepth;     // 1/far, 1/near - 1/far
uniform vec2 uGrid;         // cols, rows

vec2 bandUv(vec4 rect, vec2 st) {
  vec2 p = mix(rect.xy, rect.zw, st);
  p = clamp(p, rect.xy + uInset, rect.zw - uInset);
  return p / uTexSize;
}

// Luma recovers the grey level even if chroma from a neighbouring band leaks in.
float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float maskAt(vec2 st) { return lumaOf(texture2D(uTex, bandUv(uMaskRect, st)).rgb); }

// OpenCV pixel centres -> OpenGL camera frame.
vec3 unproject(vec2 st, float inv) {
  float z = 1.0 / max(inv, 1e-4);
  vec2 px = st * uImageSize - 0.5;
  return vec3((px.x - uIntrinsics.z) / uIntrinsics.x * z, -(px.y - uIntrinsics.w) / uIntrinsics.y * z, -z);
}

float procInv(vec4 t) {
  float u = (floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5)) / 65535.0;
  return uInvDepth.x + u * uInvDepth.y;
}
`;

const PREPASS_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// One fragment per grid vertex. Output: rg = 16-bit processed inverse depth (normalised to the
// near/far range), b = class (k / 255), a = mask at the vertex.
const PREPASS_FRAG = /* glsl */ `
${COMMON}
uniform float uSplit;
uniform float uSmoothTol;
uniform float uFillStep;
uniform float uFillOccl;
uniform float uFillMaxSpan;
uniform float uFillPair;

float invAt(vec2 st) {
  float v = lumaOf(texture2D(uTex, bandUv(uDepthRect, st)).rgb);
  return uInvDepth.x + v * uInvDepth.y;
}

// Walks from st along dir (grid cells) to the first person sample farther than inverse depth
// limit. Returns (found, distance in cells, its inverse depth) and the colour there.
vec3 findPerson(vec2 st, vec2 dir, float limit, out vec3 col) {
  col = vec3(0.0);
  for (int k = 1; k <= TW_FILL_STEPS; k++) {
    vec2 p = st + dir * (float(k) * uFillStep) / uGrid;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
    if (maskAt(p) < 0.5) continue;
    // two cells further in, away from the blend at the outline, if that is still the person
    vec2 q = clamp(p + dir * 2.0 / uGrid, vec2(0.0), vec2(1.0));
    if (maskAt(q) < 0.5) q = p;
    float iq = invAt(q);
    if (iq > limit) continue;  // the occluder itself (or something as near): keep looking
    // average with the next two samples along the way when they are the same surface, so
    // neighbouring vertices agree on the hidden depth
    col = texture2D(uTex, bandUv(uRgbRect, q)).rgb;
    float sum = iq, n = 1.0;
    for (int e = 1; e <= 2; e++) {
      vec2 r = clamp(q + dir * (float(e) * uFillStep) / uGrid, vec2(0.0), vec2(1.0));
      float ir = invAt(r);
      if (maskAt(r) < 0.5 || ir > limit || abs(ir - iq) > 0.15 * iq) break;
      sum += ir;
      col += texture2D(uTex, bandUv(uRgbRect, r)).rgb;
      n += 1.0;
    }
    col /= n;
    return vec3(1.0, float(k) * uFillStep, sum / n);
  }
  return vec3(0.0);
}

// Inverse depth (x) and colour (yzw) of the person hidden behind st, or x = 0 when there is none.
vec4 fillBehind(vec2 st, float c) {
  float limit = c / (1.0 + uFillOccl);
  vec3 c0, c1, c2, c3;
  vec3 a0 = findPerson(st, vec2(1.0, 0.0), limit, c0);
  vec3 a1 = findPerson(st, vec2(-1.0, 0.0), limit, c1);
  vec3 a2 = findPerson(st, vec2(0.0, 1.0), limit, c2);
  vec3 a3 = findPerson(st, vec2(0.0, -1.0), limit, c3);
  // a pair counts when both sides are one surface (similar depth): a hand and the torso behind
  // it at different depths would otherwise be bridged by a slab where there is only wall
  float px = a0.x * a1.x * step(a0.y + a1.y, uFillMaxSpan) * step(abs(a0.z - a1.z), uFillPair * max(a0.z, a1.z));
  float py = a2.x * a3.x * step(a2.y + a3.y, uFillMaxSpan) * step(abs(a2.z - a3.z), uFillPair * max(a2.z, a3.z));
  if (px + py < 0.5) return vec4(0.0);
  // (distances are 0 where nothing was found: guard the division, or the 0/0 poisons the sum)
  float w0 = px / max(a0.y, 1.0), w1 = px / max(a1.y, 1.0), w2 = py / max(a2.y, 1.0), w3 = py / max(a3.y, 1.0);
  float sw = w0 + w1 + w2 + w3;
  float pinv = (a0.z * w0 + a1.z * w1 + a2.z * w2 + a3.z * w3) / sw;
  return vec4(pinv, (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / sw);
}

void main() {
  vec2 st = floor(gl_FragCoord.xy) / uGrid;
#ifdef TW_FILL_COLOR
  // Back sheet: rgb = colour of the person hidden behind this vertex, a = their inverse depth
  // (8 bits over the near/far range, at least 1/255), or a = 0 when nothing is hidden here.
  vec4 behind = fillBehind(st, invAt(st));
  float ub = behind.x > 0.0 ? clamp((behind.x - uInvDepth.x) / uInvDepth.y, 1.0 / 255.0, 1.0) : 0.0;
  gl_FragColor = vec4(behind.yzw, ub);
  return;
#endif
  vec2 dx = vec2(1.0 / uGrid.x, 0.0);
  vec2 dy = vec2(0.0, 1.0 / uGrid.y);

  // Centre, 1-ring and 2-ring samples along both axes.
  float c = invAt(st);
  float n0 = invAt(st - dx), n1 = invAt(st + dx), n2 = invAt(st - dy), n3 = invAt(st + dy);
  float r0 = invAt(st - 2.0 * dx), r1 = invAt(st + 2.0 * dx), r2 = invAt(st - 2.0 * dy), r3 = invAt(st + 2.0 * dy);
  float mc = maskAt(st);
  float fc = step(0.5, mc);
  float f0 = step(0.5, maskAt(st - dx)), f1 = step(0.5, maskAt(st + dx));
  float f2 = step(0.5, maskAt(st - dy)), f3 = step(0.5, maskAt(st + dy));
  float g0 = step(0.5, maskAt(st - 2.0 * dx)), g1 = step(0.5, maskAt(st + 2.0 * dx));
  float g2 = step(0.5, maskAt(st - 2.0 * dy)), g3 = step(0.5, maskAt(st + 2.0 * dy));

  // Range of foreground inverse depth over the window (hi = the nearest surface).
  const float FAR_INV = 1e4;
  float near1 = max(c * fc, max(max(n0 * f0, n1 * f1), max(n2 * f2, n3 * f3)));
  float hi = max(near1, max(max(r0 * g0, r1 * g1), max(r2 * g2, r3 * g3)));
  float lo = min(mix(FAR_INV, c, fc), min(min(mix(FAR_INV, n0, f0), mix(FAR_INV, n1, f1)), min(mix(FAR_INV, n2, f2), mix(FAR_INV, n3, f3))));
  lo = min(lo, min(min(mix(FAR_INV, r0, g0), mix(FAR_INV, r1, g1)), min(mix(FAR_INV, r2, g2), mix(FAR_INV, r3, g3))));
  bool split = hi > 0.0 && hi - lo > uSplit * hi;
  bool nearOutline = fc + f0 + f1 + f2 + f3 + g0 + g1 + g2 + g3 < 8.5;

  float inv = c;
  float cls = 0.0;  // 0 background, 1 just outside the mask, 2 outline pulled forward, 3 snapped, 4 smoothed
  if (fc < 0.5) {
    if (near1 > 0.0) {
      // Just outside the mask: lie flat on the foreground next to it, so the soft mask edge sits
      // on the person instead of smearing back toward the wall.
      inv = split ? hi : near1;
      cls = 1.0;
    }
  } else if (split && nearOutline) {
    // Near the outline the far values are the depth model blurring the wall into the person.
    inv = hi;
    cls = 2.0;
  } else {
    // Inverse depth is affine across a plane, so second differences vanish on any flat surface,
    // however steep, and are large across a blurred occlusion step.
    float bend = max(max(abs(n0 + n1 - 2.0 * c), abs(r0 + r1 - 2.0 * c)), max(abs(n2 + n3 - 2.0 * c), abs(r2 + r3 - 2.0 * c)));
    if (split && bend > 0.3 * (hi - lo)) {
      // Occlusion step inside the person (arm over torso): snap to the nearer layer so the blurred
      // ramp becomes a one-cell step.
      inv = c - lo < hi - c ? lo : hi;
      cls = 3.0;
    } else {
      float tol = uSmoothTol * c;
      float w0 = step(abs(n0 - c), tol), w1 = step(abs(n1 - c), tol);
      float w2 = step(abs(n2 - c), tol), w3 = step(abs(n3 - c), tol);
      inv = (c + n0 * w0 + n1 * w1 + n2 * w2 + n3 * w3) / (1.0 + w0 + w1 + w2 + w3);
      cls = 4.0;
    }
  }

  float u = clamp((inv - uInvDepth.x) / uInvDepth.y, 0.0, 1.0);
  float q = floor(u * 65535.0 + 0.5);
  float qh = floor(q / 256.0);
  gl_FragColor = vec4(qh / 255.0, (q - qh * 256.0) / 255.0, cls / 255.0, mc);
}
`;

const VERT = /* glsl */ `
${COMMON}
uniform sampler2D uProc;
uniform mat4 uWorldToLocal;
uniform float uEdgeFloor;
uniform float uSplit;

varying vec2 vSt;
varying vec2 vRgbUv;
varying vec2 vMaskUv;
varying vec3 vToEye;   // from this point to the eye, in the video camera frame
varying float vEdge;

float procAt(ivec2 ij) {
  ivec2 lim = ivec2(uGrid);
  return procInv(texelFetch(uProc, clamp(ij, ivec2(0), lim), 0));
}

void main() {
  vec2 st = position.xy;
  ivec2 ij = ivec2(floor(st * uGrid + 0.5));
  float inv = procAt(ij);

  // Edge factor: largest relative jump to a neighbouring vertex. Zero where no neighbour differs
  // by more than the floor, which lets the fragment stage skip its exact tear test.
  float j = max(max(abs(procAt(ij + ivec2(-1, 0)) - inv), abs(procAt(ij + ivec2(1, 0)) - inv)),
                max(abs(procAt(ij + ivec2(0, -1)) - inv), abs(procAt(ij + ivec2(0, 1)) - inv)));
  vEdge = max(0.0, j / max(inv, 1e-4) - uEdgeFloor) / uSplit;

  vec3 p = unproject(st, inv);
  vToEye = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz - p;
  vSt = st;
  vRgbUv = bandUv(uRgbRect, st);
  vMaskUv = bandUv(uMaskRect, st);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uProc;
uniform float uOpacity;
uniform vec2 uMaskRamp;
uniform float uSplit;
uniform vec2 uTear;
uniform vec2 uTearCone;
uniform vec2 uSil;
uniform vec2 uAny;
uniform float uCut;

varying vec2 vSt;
varying vec2 vRgbUv;
varying vec2 vMaskUv;
varying vec3 vToEye;
varying float vEdge;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  float m = maskAt(vSt);
  float a = smoothstep(uMaskRamp.x, uMaskRamp.y, m) * uOpacity;
#ifndef TW_DEBUG
  if (a < 0.004) discard;
#else
  if (m < 0.05) discard;
#endif

  float keep = 1.0;
  float cls = 4.0;
  if (vEdge > 0.0) {
    // Rebuild this fragment's triangle exactly from the processed depths (same texels the vertex
    // shader used), so the decision is per triangle with no interpolation fuzz.
    vec2 g = vSt * uGrid;
    ivec2 cell = ivec2(clamp(floor(g), vec2(0.0), uGrid - 1.0));
    vec2 f = g - vec2(cell);
    ivec2 o0, o1, o2;
    if (((cell.x + cell.y) & 1) == 1) {
      if (f.x + f.y < 1.0) { o0 = ivec2(0, 0); o1 = ivec2(0, 1); o2 = ivec2(1, 0); }
      else { o0 = ivec2(1, 0); o1 = ivec2(0, 1); o2 = ivec2(1, 1); }
    } else {
      if (f.y > f.x) { o0 = ivec2(0, 0); o1 = ivec2(0, 1); o2 = ivec2(1, 1); }
      else { o0 = ivec2(0, 0); o1 = ivec2(1, 1); o2 = ivec2(1, 0); }
    }
    vec4 t0 = texelFetch(uProc, cell + o0, 0);
    vec4 t1 = texelFetch(uProc, cell + o1, 0);
    vec4 t2 = texelFetch(uProc, cell + o2, 0);
    float i0 = procInv(t0), i1 = procInv(t1), i2 = procInv(t2);
    vec3 q0 = unproject(vec2(cell + o0) / uGrid, i0);
    vec3 q1 = unproject(vec2(cell + o1) / uGrid, i1);
    vec3 q2 = unproject(vec2(cell + o2) / uGrid, i2);
    vec3 n = cross(q1 - q0, q2 - q0);
    float nl = length(n);
    if (nl > 0.0) {
      n /= nl;
      float facingSrc = abs(dot(n, normalize(q0 + q1 + q2)));
      float facingView = abs(dot(n, normalize(vToEye)));
      float stretch = facingView / max(facingSrc, 1e-3);
      float hiI = max(i0, max(i1, i2)), loI = min(i0, min(i1, i2));
      bool tear = hiI - loI > uSplit * hiI;
      float c0 = floor(t0.b * 255.0 + 0.5), c1 = floor(t1.b * 255.0 + 0.5), c2 = floor(t2.b * 255.0 + 0.5);
      bool sil = c0 == 1.0 || c1 == 1.0 || c2 == 1.0;
      vec2 lim = tear ? uTear : sil ? uSil : uAny;
      keep = 1.0 - smoothstep(lim.x, lim.y, stretch);
      // Triangles across a step, and any triangle lying almost along the video ray, only belong on
      // screen near the video camera's own line of sight (where they fill cracks); elsewhere, even
      // seen edge-on, they show up as thin wires.
      float alongRay = tear ? 1.0 : 1.0 - smoothstep(0.08, 0.12, facingSrc);
      float off = dot(normalize(vToEye), -normalize(q0 + q1 + q2));
      keep *= mix(1.0, smoothstep(uTearCone.x, uTearCone.y, off), alongRay);
      cls = tear ? 5.0 : min(c0, min(c1, c2));
    }
  }
  a *= keep;

#ifdef TW_DEBUG
  // ?twdebug: green = smooth surface, magenta = snapped occlusion step, yellow = outline pulled
  // forward, blue = just outside the mask, orange = triangle across a step, red = dropped here.
  vec3 col = cls > 4.5 ? vec3(1.0, 0.55, 0.1) : cls > 3.5 ? vec3(0.1, 0.8, 0.2) : cls > 2.5 ? vec3(0.9, 0.1, 0.9) : cls > 1.5 ? vec3(0.95, 0.85, 0.1) : vec3(0.2, 0.6, 1.0);
  col = mix(col, vec3(1.0, 0.0, 0.0), 1.0 - keep);
#ifdef TW_DEBUG_KEPT
  if (keep < 0.5) discard;
#endif
  gl_FragColor = vec4(col * (0.6 + 0.4 * lumaOf(texture2D(uTex, vRgbUv).rgb)), 1.0);
  #include <colorspace_fragment>
  return;
#endif

#ifdef TW_CORE
  if (a < uCut) discard;
  a = 1.0;
#else
  if (a < 0.004 || a >= uCut) discard;
#endif

  vec3 rgb = srgbToLinear(texture2D(uTex, vRgbUv).rgb);
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

// Back sheet: the person hidden behind occluders, at the depth and colour the fill pre-pass found.
const BACK_VERT = /* glsl */ `
${COMMON}
uniform sampler2D uFill;
uniform float uBackStep;
uniform mat4 uWorldToLocal;

varying vec3 vRgb;
varying float vHas;   // 1 where this vertex has something hidden behind it
varying float vEdge;  // 1 where the back sheet jumps in depth to a neighbour
varying vec3 vP;      // position in the video camera frame
varying vec3 vToEye;  // from this point to the eye, in the video camera frame

void main() {
  vec2 st = position.xy;
  ivec2 ij = ivec2(floor(st * uGrid + 0.5));
  // smoothed over the 3x3 vertices that have a hidden surface (a vertex without one borrows it
  // when most neighbours have it, which closes one-vertex gaps); a step over uBackStep to a
  // neighbour means two different surfaces, and no triangle of the sheet is drawn across it
  float sum = 0.0, cnt = 0.0;
  vec3 rgb = vec3(0.0);
  // (5 rows tall: the searches run along rows, so neighbouring rows disagree the most)
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 tq = texelFetch(uFill, clamp(ij + ivec2(dx, dy), ivec2(0), ivec2(uGrid)), 0);
      if (tq.a <= 0.0) continue;
      float w = dx == 0 && dy == 0 ? 3.0 : abs(dy) == 2 ? 0.5 : 1.0;
      sum += (uInvDepth.x + tq.a * uInvDepth.y) * w;
      rgb += tq.rgb * w;
      cnt += w;
    }
  }
  float inv = cnt > 0.0 ? sum / cnt : 1.0;
  float j = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
    vec4 tq = texelFetch(uFill, clamp(ij + o, ivec2(0), ivec2(uGrid)), 0);
    if (tq.a > 0.0) j = max(j, abs(uInvDepth.x + tq.a * uInvDepth.y - inv) / inv);
  }
  vHas = cnt >= 6.0 ? 1.0 : 0.0;
  vRgb = cnt > 0.0 ? rgb / cnt : vec3(0.0);
  vEdge = step(uBackStep, j);
  vec3 p = unproject(st, inv);
  vP = p;
  vToEye = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz - p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const BACK_FRAG = /* glsl */ `
uniform vec2 uBackStretch;

varying vec3 vRgb;
varying float vHas;
varying float vEdge;
varying vec3 vP;
varying vec3 vToEye;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  // only whole triangles of the sheet, and none that bridge a step in it
  if (vHas < 0.999 || vEdge > 0.001) discard;
  // a guessed surface: never show it much more face-on than the video camera saw that spot
  vec3 n = cross(dFdx(vP), dFdy(vP));
  float nl = length(n);
  if (nl > 0.0) {
    n /= nl;
    float stretch = abs(dot(n, normalize(vToEye))) / max(abs(dot(n, normalize(vP))), 1e-3);
    if (stretch > mix(uBackStretch.x, uBackStretch.y, fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453))) discard;
  }
#ifdef TW_DEBUG
  gl_FragColor = vec4(0.1, 0.85, 0.95, 1.0);
#else
  gl_FragColor = vec4(srgbToLinear(vRgb), 1.0);
#endif
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------

/**
 * Index buffer for a (cols x rows) cell grid whose vertex (i, j) is at index j * (cols + 1) + i.
 * The diagonal alternates with cell parity so slopes do not get a directional sawtooth; keep in
 * sync with cellTriangle() and the fragment shader.
 */
export function gridIndices(cols: number, rows: number): Uint16Array | Uint32Array {
  const count = (cols + 1) * (rows + 1);
  const idx = count > 65535 ? new Uint32Array(cols * rows * 6) : new Uint16Array(cols * rows * 6);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      if ((i + j) & 1) {
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      } else {
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  return idx;
}

function buildGrid(cols: number, rows: number): THREE.BufferGeometry {
  const count = (cols + 1) * (rows + 1);
  const pos = new Float32Array(count * 3);
  let k = 0;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      pos[k++] = i / cols;
      pos[k++] = j / rows;
      pos[k++] = 0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(gridIndices(cols, rows), 1));
  // The real extent is only known on the GPU; the meshes skip frustum culling.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -2), 50);
  return g;
}

function rectVec(r: PixelRect): THREE.Vector4 {
  return new THREE.Vector4(r.x0, r.y0, r.x1, r.y1);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const MEDIA_ERRORS: Record<number, string> = {
  1: 'loading the video was cancelled',
  2: 'a network error interrupted the video download',
  3: 'this browser could not decode the video',
  4: 'the video file is missing or in a format this browser cannot play',
};

export function createVideoLayer(layer: VideoLayer, baseUrl: string, renderer: THREE.WebGLRenderer): VideoLayerHandle {
  const url = resolveSceneFile(baseUrl, layer.file);
  const T = TW_TUNING;

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.loop = true;
  video.muted = false;
  // Some mobile browsers only keep decoding frames for elements that are in the document.
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
  if (typeof document !== 'undefined' && document.body) document.body.appendChild(video);
  video.src = url;

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.NoColorSpace; // raw values: depth and mask are data, RGB is decoded in-shader
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const nominal = packedSize(layer.width, layer.height);
  let pack = packLayout(nominal.width, nominal.height);
  const [cols, rows] = gridDims(layer.width, layer.height, T.maxGridSegments);

  // Processed depth, one texel per grid vertex.
  const proc = new THREE.WebGLRenderTarget(cols + 1, rows + 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  proc.texture.colorSpace = THREE.NoColorSpace;
  // Colour of the person where they are filled in behind an object, one texel per grid vertex.
  const fillRt = new THREE.WebGLRenderTarget(cols + 1, rows + 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  fillRt.texture.colorSpace = THREE.NoColorSpace;

  const shared = {
    uTex: { value: texture as THREE.Texture },
    uTexSize: { value: new THREE.Vector2(pack.texWidth, pack.texHeight) },
    uRgbRect: { value: rectVec(pack.rgb) },
    uDepthRect: { value: rectVec(pack.depth) },
    uMaskRect: { value: rectVec(pack.mask) },
    uInset: { value: T.bandInset },
    uImageSize: { value: new THREE.Vector2(layer.width, layer.height) },
    uIntrinsics: { value: new THREE.Vector4(layer.intrinsics.fx, layer.intrinsics.fy, layer.intrinsics.cx, layer.intrinsics.cy) },
    uInvDepth: { value: new THREE.Vector2(1 / layer.depth.far, 1 / layer.depth.near - 1 / layer.depth.far) },
    uGrid: { value: new THREE.Vector2(cols, rows) },
    uSplit: { value: T.splitThreshold },
  };
  const prepassUniforms = {
    ...shared,
    uSmoothTol: { value: T.smoothTolerance },
    uFillStep: { value: T.fillStep },
    uFillOccl: { value: T.fillOcclusion },
    uFillMaxSpan: { value: T.fillMaxSpan },
    uFillPair: { value: T.fillPair },
  };
  const prepassMat = new THREE.ShaderMaterial({
    name: 'ThirdWheelDepthPrepass',
    uniforms: prepassUniforms,
    defines: { TW_FILL_STEPS: T.fillSteps },
    vertexShader: PREPASS_VERT,
    fragmentShader: PREPASS_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const fillMat = new THREE.ShaderMaterial({
    name: 'ThirdWheelFillColour',
    uniforms: prepassUniforms,
    defines: { TW_FILL_STEPS: T.fillSteps, TW_FILL_COLOR: 1 },
    vertexShader: PREPASS_VERT,
    fragmentShader: PREPASS_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const prepassScene = new THREE.Scene();
  const prepassQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), prepassMat);
  prepassQuad.frustumCulled = false;
  prepassScene.add(prepassQuad);
  const prepassCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    ...shared,
    uProc: { value: proc.texture as THREE.Texture },
    uWorldToLocal: { value: new THREE.Matrix4() },
    uEdgeFloor: { value: T.edgeFloor },
    uOpacity: { value: 1 },
    uMaskRamp: { value: new THREE.Vector2(T.maskLow, T.maskHigh) },
    uTear: { value: new THREE.Vector2(T.tearLow, T.tearHigh) },
    uTearCone: { value: new THREE.Vector2(Math.cos((T.tearConeOuterDeg * Math.PI) / 180), Math.cos((T.tearConeInnerDeg * Math.PI) / 180)) },
    uSil: { value: new THREE.Vector2(T.silLow, T.silHigh) },
    uAny: { value: new THREE.Vector2(T.anyLow, T.anyHigh) },
    uCut: { value: T.coreCut },
  };
  // The fringe pass has its own cut so the core and fringe partition alpha cleanly.
  const fringeUniforms = { ...uniforms, uCut: { value: T.coreCut } };

  // ?twdebug on the page URL colours triangles by how their depth was classified.
  const debugParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('twdebug') : null;
  const debug = debugParam !== null;
  const debugDefines: Record<string, number> = debug ? { TW_DEBUG: 1, ...(debugParam === 'kept' ? { TW_DEBUG_KEPT: 1 } : {}) } : {};
  const coreMat = new THREE.ShaderMaterial({
    name: 'ThirdWheelCore',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: { TW_CORE: 1, ...debugDefines },
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  const fringeMat = new THREE.ShaderMaterial({
    name: 'ThirdWheelFringe',
    uniforms: fringeUniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: debugDefines,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const geometry = buildGrid(cols, rows);
  const core = new THREE.Mesh(geometry, coreMat);
  core.name = 'tw-core';
  core.frustumCulled = false;
  core.renderOrder = 0;
  const fringe = new THREE.Mesh(geometry, fringeMat);
  fringe.name = 'tw-fringe';
  fringe.frustumCulled = false;
  fringe.renderOrder = 100; // after the SparkRenderer (renderOrder 0) in the transparent pass

  const backMat = new THREE.ShaderMaterial({
    name: 'ThirdWheelBack',
    uniforms: {
      ...shared,
      uFill: { value: fillRt.texture as THREE.Texture },
      uBackStep: { value: T.backStep },
      uBackStretch: { value: new THREE.Vector2(T.backStretchLow, T.backStretchHigh) },
      uWorldToLocal: uniforms.uWorldToLocal,
    },
    vertexShader: BACK_VERT,
    fragmentShader: BACK_FRAG,
    defines: debug ? { TW_DEBUG: 1 } : {},
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  const back = new THREE.Mesh(geometry, backMat);
  back.name = 'tw-back';
  back.frustumCulled = false;
  back.renderOrder = 0;

  const object = new THREE.Group();
  object.name = 'ThirdWheelVideo';
  object.add(back, core, fringe);
  const [px, py, pz] = layer.cameraPose.position;
  const [qx, qy, qz, qw] = layer.cameraPose.quaternion;
  object.position.set(px, py, pz);
  object.quaternion.set(qx, qy, qz, qw).normalize();
  object.visible = false; // until the first frame is decoded and processed

  // Where the person is, in the video camera frame. Refined from the mask a few times a second.
  const subject = new THREE.Vector3(0, 0, -2);
  let subjectKnown = false;
  object.userData.thirdWheel = { subject, uniforms, fringeUniforms, tuning: T, url, grid: [cols, rows], targets: { proc, fill: fillRt } };

  let userOpacity = 1;
  let viewFade = 1;
  let ready_ = false;
  let processed = false;
  let disposed = false;
  let lastFrameAt = 0;
  let lastMediaTime = -1;
  let lastProbeAt = -Infinity;
  let lastProcessedVersion = -1;
  let rvfcId = 0;

  function applyOpacity() {
    const o = userOpacity * viewFade;
    object.visible = o > 0.003 && ready_ && processed;
    const fading = o < 0.995;
    uniforms.uOpacity.value = o;
    core.visible = !fading;
    // the back sheet is opaque: it only shows with the person at full opacity
    back.visible = !fading;
    // While fading, the blended pass draws everything and writes depth for self-occlusion.
    fringeUniforms.uCut.value = fading ? 2 : T.coreCut;
    fringeMat.depthWrite = fading;
  }

  function adoptDecodedSize() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (w === pack.texWidth && h === pack.texHeight) return;
    const expected = layer.height * 1.5;
    if (Math.abs(h / w - expected / layer.width) > 0.02) {
      console.warn(`[thirdwheel] ${url}: decoded ${w}x${h}, expected tw-pack-v1 ${layer.width}x${expected}`);
    }
    pack = packLayout(w, h);
    shared.uTexSize.value.set(w, h);
    shared.uRgbRect.value.copy(rectVec(pack.rgb));
    shared.uDepthRect.value.copy(rectVec(pack.depth));
    shared.uMaskRect.value.copy(rectVec(pack.mask));
  }

  /** Runs the depth pre-pass into `proc`. Leaves the renderer's target and XR state as found. */
  function runPrepass() {
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(proc);
    prepassQuad.material = prepassMat;
    renderer.render(prepassScene, prepassCam);
    renderer.setRenderTarget(fillRt);
    prepassQuad.material = fillMat;
    renderer.render(prepassScene, prepassCam);
    prepassQuad.material = prepassMat;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXr;
    if (!processed) {
      processed = true;
      applyOpacity();
    }
  }

  // Small CPU probe of the mask and depth bands to locate the subject.
  let probe: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  let probeBroken = false;
  function probeSubject() {
    if (probeBroken || video.readyState < 2) return;
    try {
      if (!probe) {
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = Math.max(6, Math.round((96 * pack.texHeight) / pack.texWidth / 6) * 6);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d context');
        probe = { canvas, ctx };
      }
      const { canvas, ctx } = probe;
      const W = canvas.width, H = canvas.height;
      ctx.drawImage(video, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      const y0 = Math.round((H * 2) / 3), half = W / 2, bandH = H - y0;
      let sw = 0, ss = 0, st = 0, sinv = 0;
      for (let y = y0 + 1; y < H - 1; y++) {
        for (let x = 1; x < half - 1; x++) {
          const m = data[(y * W + x + half) * 4 + 1] / 255;
          if (m < 0.5) continue;
          const v = data[(y * W + x) * 4 + 1] / 255;
          sw += m;
          ss += m * ((x + 0.5) / half);
          st += m * ((y - y0 + 0.5) / bandH);
          sinv += m * (shared.uInvDepth.value.x + v * shared.uInvDepth.value.y);
        }
      }
      if (sw > 2) {
        const s = ss / sw, t = st / sw, d = 1 / (sinv / sw);
        const [ix, iy] = gridToPixel(s, t, layer.width, layer.height);
        const p = unprojectPixel(ix, iy, d, layer.intrinsics);
        if (!subjectKnown) subject.set(p[0], p[1], p[2]);
        else subject.lerp(new THREE.Vector3(p[0], p[1], p[2]), 0.35);
        subjectKnown = true;
      }
    } catch (err) {
      // A cross-origin video without CORS headers taints the canvas; the default subject stays.
      probeBroken = true;
      console.warn('[thirdwheel] subject probe disabled:', err);
    }
  }

  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
  function onVideoFrame(_now: number, meta: VideoFrameCallbackMetadata) {
    if (disposed) return;
    lastFrameAt = performance.now();
    lastMediaTime = meta.mediaTime;
    if (lastFrameAt - lastProbeAt > 400) {
      lastProbeAt = lastFrameAt;
      probeSubject();
    }
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }
  if (hasRvfc) rvfcId = video.requestVideoFrameCallback(onVideoFrame);

  const ready = new Promise<void>((resolve, reject) => {
    const onData = () => {
      if (ready_) return;
      ready_ = true;
      adoptDecodedSize();
      texture.needsUpdate = true;
      probeSubject();
      applyOpacity();
      resolve();
    };
    if (video.readyState >= 2) queueMicrotask(onData);
    video.addEventListener('loadeddata', onData);
    video.addEventListener('loadedmetadata', adoptDecodedSize);
    video.addEventListener(
      'error',
      () => {
        if (ready_) return;
        const code = video.error?.code ?? 0;
        console.warn(`[thirdwheel] ${url}: media error ${code}`);
        reject(new Error(`The room still works, but ${MEDIA_ERRORS[code] ?? 'the video stopped loading for an unknown reason'}.`));
      },
      { once: true },
    );
  });
  ready.catch(() => {});

  // A paused seek presents a new frame; make sure it is uploaded even without rVFC.
  video.addEventListener('seeked', () => {
    texture.needsUpdate = true;
    lastProbeAt = performance.now();
    probeSubject();
  });

  if (!renderer.capabilities.isWebGL2 || renderer.capabilities.maxVertexTextures < 2) {
    console.warn('[thirdwheel] vertex texture fetch unavailable; the video layer will not render');
  }

  const tmpView = new THREE.Vector3();
  const tmpToCam = new THREE.Vector3();
  const worldToLocal = uniforms.uWorldToLocal.value;

  const handle: VideoLayerHandle = {
    object,
    video,
    ready,
    async play() {
      await video.play();
    },
    pause() {
      video.pause();
    },
    seek(t: number) {
      const d = handle.duration;
      video.currentTime = Math.max(0, Number.isFinite(d) && d > 0 ? Math.min(t, d - 0.001) : t);
    },
    get playing() {
      return !video.paused && !video.ended;
    },
    get currentTime() {
      return video.currentTime;
    },
    get duration() {
      return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : layer.duration;
    },
    update(dt: number, camera: THREE.Camera) {
      if (disposed) return;
      const now = performance.now();

      // Without rVFC, or when it stalls (some browsers throttle it during immersive XR), upload
      // whenever the media time moves.
      if (video.readyState >= 2 && (!hasRvfc || now - lastFrameAt > 120)) {
        const t = video.currentTime;
        if (t !== lastMediaTime) {
          lastMediaTime = t;
          texture.needsUpdate = true;
          if (now - lastProbeAt > 500) {
            lastProbeAt = now;
            probeSubject();
          }
        }
      }
      // Re-process depth once per new frame (the pre-pass also performs the texture upload).
      if (ready_ && texture.version !== lastProcessedVersion) {
        lastProcessedVersion = texture.version;
        runPrepass();
      }

      object.updateWorldMatrix(true, false);
      worldToLocal.copy(object.matrixWorld).invert();

      // Fade when the viewer walks far around the side or behind the person (the relief has no
      // back), and when they step into the person.
      camera.getWorldPosition(tmpView);
      tmpView.applyMatrix4(worldToLocal).sub(subject);
      tmpToCam.copy(subject).negate();
      const dist = tmpView.length();
      const angle = dist > 1e-6 && tmpToCam.lengthSq() > 1e-9 ? THREE.MathUtils.radToDeg(tmpView.angleTo(tmpToCam)) : 0;
      const around = 1 - (1 - T.fadeMin) * smoothstep(T.fadeStartDeg, T.fadeEndDeg, angle);
      const near = smoothstep(0.15, 0.5, dist);
      const target = around * near;
      const k = dt > 0 ? 1 - Math.exp(-dt * 10) : 1;
      viewFade += (target - viewFade) * k;
      if (Math.abs(viewFade - target) < 1e-3) viewFade = target;
      applyOpacity();
    },
    setOpacity(o: number) {
      userOpacity = Math.min(1, Math.max(0, o));
      applyOpacity();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(rvfcId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      object.removeFromParent();
      texture.dispose();
      proc.dispose();
      fillRt.dispose();
      geometry.dispose();
      prepassQuad.geometry.dispose();
      prepassMat.dispose();
      fillMat.dispose();
      coreMat.dispose();
      fringeMat.dispose();
      backMat.dispose();
    },
  };
  return handle;
}
