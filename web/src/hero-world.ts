// The landing page's live world: a Spark view of a real world that slowly looks around from where
// you would stand in it. Loaded on demand (the landing page imports this file only once the hero is
// on screen); the page keeps its poster image until the first frame is drawn, and keeps it for good
// when WebGL or the world is missing.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Scene } from '../../shared/types.ts';
import { sceneAssetUrl } from './api.ts';

export interface HeroWorldOptions {
  /** A phone: lower resolution, a smaller splat budget, wider lens. */
  mobile: boolean;
  /** Reduced motion: draw a still frame instead of looking around. */
  still: boolean;
  /** Clear colour behind the splats. */
  background?: number;
}

export interface HeroWorld {
  /** Runs or pauses the render loop (off screen, hidden tab). */
  setRunning(on: boolean): void;
  /** The host changed size. */
  resize(): void;
  /**
   * How far out each splat is drawn, in standard deviations: small values draw every splat as a
   * pinpoint, about 2.8 draws them as the soft blobs that blend into a surface.
   */
  setDetail(stdDev: number): void;
  dispose(): void;
}

const EYE = 1.6;
/** One slow look left and right, in seconds. */
const PERIOD = 44;
/** How far the view turns to either side, in radians. */
const SWING = 0.42;

export async function mountHeroWorld(host: HTMLElement, scene: Scene, opts: HeroWorldOptions): Promise<HeroWorld> {
  const world = scene.world;
  if (!world?.file) throw new Error('this scene has no world');

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: opts.mobile ? 'low-power' : 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.mobile ? 1 : 1.5));
  renderer.setClearColor(opts.background ?? 0x1c1c1e, 1);
  const canvas = renderer.domElement;
  canvas.className = 'hero-world-canvas';
  host.append(canvas);

  const scene3 = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.mobile ? 68 : 56, 1, 0.05, 300);
  const spark = new SparkRenderer({
    renderer,
    // a preview: fewer, softer splats than the viewer draws
    maxStdDev: Math.sqrt(opts.mobile ? 5 : 7),
    lodSplatCount: opts.mobile ? 300_000 : 900_000,
  });
  scene3.add(spark);

  const mesh = new SplatMesh({
    url: sceneAssetUrl(scene.id, world.file),
    // phones always get a level-of-detail tree so the budget above applies
    lod: true,
    lodAbove: opts.mobile ? 0 : 1_500_000,
  });
  const [px, py, pz] = world.transform.position ?? [0, 0, 0];
  const [qx, qy, qz, qw] = world.transform.quaternion ?? [0, 0, 0, 1];
  mesh.position.set(px, py, pz);
  mesh.quaternion.set(qx, qy, qz, qw).normalize();
  mesh.scale.setScalar(world.transform.scale || 1);
  scene3.add(mesh);

  // stand where the world was made from, at eye height, facing the way it was shot
  const spawn = world.spawn;
  const floor = spawn ? spawn.position[1] : world.floorY ?? 0;
  const eye = new THREE.Vector3(spawn?.position[0] ?? 0, floor + EYE, spawn?.position[2] ?? 0);
  const yaw0 = spawn?.yaw ?? 0;
  const look = new THREE.Vector3();
  const pose = (t: number) => {
    const phase = (Math.PI * 2 * t) / PERIOD;
    const yaw = yaw0 + SWING * Math.sin(phase);
    // a small sideways drift, so near things move against far ones
    const drift = 0.22 * Math.sin(phase + Math.PI / 2);
    camera.position.set(eye.x + Math.cos(yaw0) * drift, eye.y, eye.z - Math.sin(yaw0) * drift);
    look.set(camera.position.x - Math.sin(yaw), eye.y - 0.12, camera.position.z - Math.cos(yaw));
    camera.lookAt(look);
  };

  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  try {
    await mesh.initialized;
  } catch (e) {
    // no world after all: give the WebGL context back rather than leave it alive and unused
    mesh.dispose();
    spark.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    throw e;
  }

  let running = false;
  let raf = 0;
  let frames = 0;
  const start = performance.now();
  const frame = (now: number) => {
    raf = 0;
    if (!running) return;
    pose(opts.still ? 0 : (now - start) / 1000);
    renderer.render(scene3, camera);
    // a couple of frames in, the splats are sorted: show the canvas over the poster
    if (++frames === 3) host.classList.add('is-live');
    // a still frame needs a few draws for the sort to settle, then stops
    if (!opts.still || frames < 30) raf = requestAnimationFrame(frame);
  };

  return {
    setRunning(on: boolean) {
      if (on === running) return;
      running = on;
      if (on && !raf) raf = requestAnimationFrame(frame);
    },
    resize,
    setDetail(stdDev: number) {
      spark.maxStdDev = stdDev;
      // a still frame has stopped drawing: draw the new size once
      if (running && !raf) raf = requestAnimationFrame(frame);
    },
    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      mesh.dispose();
      spark.dispose();
      renderer.dispose();
      canvas.remove();
      host.classList.remove('is-live');
    },
  };
}
