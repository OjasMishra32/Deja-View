// Visual polish: gradient sky dome, head-locked veil (fades, vignette, leaving-the-world fade),
// a splat modifier for the load reveal and the soft edge where the world ends, and the intro move.

import * as THREE from 'three';
import { dyno, type SplatMesh } from '@sparkjsdev/spark';
import type { Bounds, RGB, SkyPalette } from './analysis.ts';

const v3 = (c: RGB) => new THREE.Vector3(c[0], c[1], c[2]);

// Colours in these shaders are sRGB display values written straight to the sRGB framebuffer,
// matching how Spark writes splat colours when the output colour space is sRGB.

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: {
    top: { value: THREE.Vector3 };
    horizon: { value: THREE.Vector3 };
    bottom: { value: THREE.Vector3 };
    glowDir: { value: THREE.Vector3 };
    glow: { value: number };
  };

  constructor(radius = 400) {
    this.uniforms = {
      top: { value: new THREE.Vector3(0.09, 0.1, 0.13) },
      horizon: { value: new THREE.Vector3(0.24, 0.25, 0.29) },
      bottom: { value: new THREE.Vector3(0.05, 0.05, 0.06) },
      glowDir: { value: new THREE.Vector3(0, 0, -1) },
      glow: { value: 0.12 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 bottom;
        uniform vec3 glowDir;
        uniform float glow;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          // eased at the horizon so there is no crease where the two halves meet
          vec3 col = h >= 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 1.0, h), 0.6))
                              : mix(horizon, bottom, pow(smoothstep(0.0, 1.0, -h), 0.45));
          // soft light toward the front of the world
          float g = pow(max(dot(d, normalize(glowDir)), 0.0), 6.0) * glow * (1.0 - smoothstep(0.0, 1.0, abs(h)));
          col += g * (horizon + 0.15);
          // dither to avoid banding in dark gradients
          col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    // stay centred on whichever camera renders (desktop or each XR eye). Read the matrix only:
    // getWorldPosition() would recompute an XR eye camera's world matrix without the rig.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
      this.mesh.updateMatrixWorld();
    };
  }

  setPalette(p: SkyPalette): void {
    this.uniforms.top.value.copy(v3(p.top));
    this.uniforms.horizon.value.copy(v3(p.horizon));
    this.uniforms.bottom.value.copy(v3(p.bottom));
  }

  setGlowDirection(dir: THREE.Vector3): void {
    this.uniforms.glowDir.value.copy(dir).normalize();
  }
}

/**
 * A small sphere locked to the head, drawn last: fades to a colour (load, teleport, leaving the
 * world) and draws the comfort vignette.
 */
export class HeadVeil {
  readonly mesh: THREE.Mesh;
  private readonly u: {
    fadeColor: { value: THREE.Vector3 };
    fade: { value: number };
    vignette: { value: number };
    vignetteColor: { value: THREE.Vector3 };
  };
  fade = 1;
  vignette = 0;

  constructor() {
    this.u = {
      fadeColor: { value: new THREE.Vector3(0.02, 0.02, 0.025) },
      fade: { value: 1 },
      vignette: { value: 0 },
      vignetteColor: { value: new THREE.Vector3(0.015, 0.015, 0.02) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.u,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 fadeColor;
        uniform float fade;
        uniform float vignette;
        uniform vec3 vignetteColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float ang = acos(clamp(-d.z, -1.0, 1.0));
          // the tunnel closes from ~63 deg (barely moving) to ~24 deg (walking) off the gaze, and is
          // fully dark from ~47 deg at walking speed
          float inner = mix(1.1, 0.42, vignette);
          float v = smoothstep(inner, inner + 0.4, ang) * smoothstep(0.0, 0.08, vignette);
          float a = max(v, fade);
          vec3 col = mix(vignetteColor, fadeColor, fade >= v ? 1.0 : fade / max(v, 1e-3));
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 16), material);
    this.mesh.name = 'veil';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10000;
  }

  setFadeColor(c: RGB): void {
    this.u.fadeColor.value.copy(v3(c));
  }

  /** Applies the current fade/vignette values; hides the mesh when fully clear. */
  sync(): void {
    this.u.fade.value = Math.min(1, Math.max(0, this.fade));
    this.u.vignette.value = Math.min(1, Math.max(0, this.vignette));
    this.mesh.visible = this.u.fade.value > 0.002 || this.u.vignette.value > 0.002;
  }
}

/** A camera's view in world space, for fading out what it never saw. */
export interface ViewCone {
  position: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  /** Image edges as tangents: left, right, down, up (all positive). */
  tans: [number, number, number, number];
  /** Fade width past the frame edge, in tangent units. */
  soft: number;
  /** The fade starts this far inside the frame (tangent units), so the picture has no hard edge. */
  inset: number;
}

/**
 * GPU splat modifier: a reveal front that grows from the spawn on load, a soft alpha falloff for
 * splats outside the world bounds so the world dissolves into the sky instead of ending in hard
 * junk, and (for rooms lifted from one camera) a soft fade of everything outside that camera's view.
 */
export class SplatFx {
  readonly reveal = dyno.dynoFloat(1e5);
  /** Width of the reveal front (metres): splats fade in over this distance behind it. */
  readonly revealBand = dyno.dynoFloat(0.8);
  readonly origin = dyno.dynoVec3(new THREE.Vector3());
  readonly boxMin = dyno.dynoVec3(new THREE.Vector3(-1e4, -1e4, -1e4));
  readonly boxMax = dyno.dynoVec3(new THREE.Vector3(1e4, 1e4, 1e4));
  readonly edge = dyno.dynoFloat(2.5);
  readonly glow = dyno.dynoFloat(0.35);
  readonly conePos = dyno.dynoVec3(new THREE.Vector3());
  readonly coneRight = dyno.dynoVec3(new THREE.Vector3(1, 0, 0));
  readonly coneUp = dyno.dynoVec3(new THREE.Vector3(0, 1, 0));
  readonly coneFwd = dyno.dynoVec3(new THREE.Vector3(0, 0, -1));
  readonly coneTans = dyno.dynoVec4(new THREE.Vector4(1e3, 1e3, 1e3, 1e3));
  /** x: fade width (tangent units), y: 1 when the view fade is on. */
  readonly coneSoft = dyno.dynoVec4(new THREE.Vector4(0.3, 0, 0, 0));
  private mesh: SplatMesh | null = null;

  attach(mesh: SplatMesh): void {
    this.mesh = mesh;
    const self = this;
    mesh.worldModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const fx = new dyno.Dyno({
        inTypes: {
          gsplat: dyno.Gsplat, reveal: 'float', rband: 'float', origin: 'vec3', bmin: 'vec3', bmax: 'vec3', edge: 'float', glow: 'float',
          cpos: 'vec3', cright: 'vec3', cup: 'vec3', cfwd: 'vec3', ctans: 'vec4', csoft: 'vec4',
        },
        outTypes: { gsplat: dyno.Gsplat },
        inputs: {
          gsplat, reveal: self.reveal, rband: self.revealBand, origin: self.origin, bmin: self.boxMin, bmax: self.boxMax, edge: self.edge, glow: self.glow,
          cpos: self.conePos, cright: self.coneRight, cup: self.coneUp, cfwd: self.coneFwd, ctans: self.coneTans, csoft: self.coneSoft,
        },
        statements: ({ inputs, outputs }) => [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `{`,
          `  vec3 c = ${inputs.gsplat}.center;`,
          `  vec3 q = max(max(${inputs.bmin} - c, c - ${inputs.bmax}), vec3(0.0));`,
          `  float keep = 1.0 - smoothstep(0.0, ${inputs.edge}, length(q));`,
          `  float r = distance(c, ${inputs.origin});`,
          `  float front = ${inputs.reveal};`,
          `  float bw = max(${inputs.rband}, 1e-3);`,
          `  float shown = 1.0 - smoothstep(front - bw, front, r);`,
          `  float band = smoothstep(front - bw, front - 0.4375 * bw, r) * shown;`,
          // outside the camera's view: fade by how far past the frame edge the splat lies
          `  if (${inputs.csoft}.y > 0.5) {`,
          `    vec3 dc = c - ${inputs.cpos};`,
          `    float dz = dot(dc, ${inputs.cfwd});`,
          `    float tx = dot(dc, ${inputs.cright}) / max(dz, 1e-3);`,
          `    float ty = dot(dc, ${inputs.cup}) / max(dz, 1e-3);`,
          // signed distance to the frame edge in tangent units (negative inside the frame)
          `    float sx = max(-${inputs.ctans}.x - tx, tx - ${inputs.ctans}.y);`,
          `    float sy = max(-${inputs.ctans}.z - ty, ty - ${inputs.ctans}.w);`,
          `    float out_ = length(max(vec2(sx, sy), 0.0)) + min(max(sx, sy), 0.0);`,
          `    if (dz <= 0.02) out_ = 10.0;`,
          `    keep *= 1.0 - smoothstep(-${inputs.csoft}.z, ${inputs.csoft}.x, out_);`,
          `  }`,
          `  ${outputs.gsplat}.rgba.a *= keep * shown;`,
          `  ${outputs.gsplat}.rgba.rgb += band * ${inputs.glow} * vec3(1.0, 0.82, 0.55);`,
          `}`,
        ],
      });
      return { gsplat: fx.outputs.gsplat };
    });
    mesh.updateGenerator();
  }

  setBounds(b: Bounds, edge: number): void {
    this.boxMin.value.set(b.min[0], b.min[1], b.min[2]);
    this.boxMax.value.set(b.max[0], b.max[1], b.max[2]);
    this.edge.value = edge;
    this.touch();
  }

  /** Fades out splats the given camera never saw (null turns the fade off). */
  setViewCone(cone: ViewCone | null): void {
    if (cone) {
      this.conePos.value.copy(cone.position);
      this.coneRight.value.copy(cone.right);
      this.coneUp.value.copy(cone.up);
      this.coneFwd.value.copy(cone.forward);
      this.coneTans.value.set(...cone.tans);
      this.coneSoft.value.set(cone.soft, 1, cone.inset, 0);
    } else {
      this.coneSoft.value.set(0.3, 0, 0, 0);
    }
    this.touch();
  }

  /** Places the reveal front; `band` is its width in metres (0.8 when left out). */
  setReveal(radius: number, origin?: THREE.Vector3, band = 0.8): void {
    this.reveal.value = radius;
    this.revealBand.value = band;
    if (origin) this.origin.value.copy(origin);
    this.touch();
  }

  /** Tells Spark the modifier inputs changed so the splats are regenerated. */
  touch(): void {
    this.mesh?.updateVersion();
  }
}

/**
 * A soft pool of floor under the walk area, for rooms that have no floor of their own where you
 * stand (a room lifted from one camera never saw the floor at your feet). Fades into the sky.
 */
export class GroundGlow {
  readonly mesh: THREE.Mesh;
  private readonly u: { color: { value: THREE.Vector3 }; inner: { value: number }; outer: { value: number }; strength: { value: number } };

  constructor() {
    this.u = {
      color: { value: new THREE.Vector3(0.2, 0.19, 0.18) },
      inner: { value: 0.2 },
      outer: { value: 1 },
      strength: { value: 0.92 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexShader: /* glsl */ `
        varying vec2 vXZ;
        void main() {
          vXZ = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        uniform float inner;
        uniform float outer;
        uniform float strength;
        varying vec2 vXZ;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          float r = length(vXZ);
          float a = (1.0 - smoothstep(inner, outer, r)) * strength;
          // a touch lighter in the middle, like light falling on the floor where you stand
          vec3 col = color * (1.0 + 0.18 * (1.0 - smoothstep(0.0, outer, r)));
          col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 64), material);
    this.mesh.name = 'ground-glow';
    this.mesh.rotation.x = -Math.PI / 2;
    // before the splats (transparent pass) so everything in the room draws over it
    this.mesh.renderOrder = -500;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Places the pool (floor at y) and sets its radius and colour. */
  set(x: number, y: number, z: number, radius: number, color: RGB): void {
    this.mesh.position.set(x, y + 0.003, z);
    // the disc is a unit circle scaled to the radius, so the falloff is in disc units
    this.mesh.scale.setScalar(radius);
    this.u.outer.value = 1;
    this.u.inner.value = 0.2;
    this.u.color.value.copy(v3(color));
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export interface CameraPose {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
}

/** A short eased camera move into the spawn pose. */
export class IntroMove {
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly duration: number;
  t = 0;
  done = false;

  constructor(from: CameraPose, to: CameraPose, duration = 2.8) {
    this.from = from;
    this.to = to;
    this.duration = duration;
  }

  /** Advances and writes the interpolated pose. Returns false once finished. */
  step(dt: number, out: CameraPose): boolean {
    if (this.done) return false;
    this.t = Math.min(1, this.t + dt / this.duration);
    const e = easeInOutCubic(this.t);
    out.position.lerpVectors(this.from.position, this.to.position, e);
    let dy = this.to.yaw - this.from.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    out.yaw = this.from.yaw + dy * e;
    out.pitch = this.from.pitch + (this.to.pitch - this.from.pitch) * e;
    if (this.t >= 1) this.done = true;
    return true;
  }
}
