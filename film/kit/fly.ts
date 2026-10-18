// A cinematic fly-through of one world: its own spawn, a slow dolly and turn (or a rise), and a small label in the
// site's style naming the world and what it was made from.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ease, el, json, lerp, reveal, seg, stage, type Shot } from './lib';

export interface Fly {
  scene: string;
  name: string;
  made: string;
  duration?: number;
  /** offsets from the spawn, in metres, in the spawn's own frame (x right, z forward); yaw/pitch in degrees */
  from: { x?: number; y: number; z: number; yaw?: number; pitch?: number };
  to: { x?: number; y: number; z: number; yaw?: number; pitch?: number };
  fov?: number;
}

export function fly(f: Fly): Shot {
  const DUR = f.duration ?? 8;
  let S: ReturnType<typeof stage>;
  let spark: SparkRenderer;
  let spawn = new THREE.Vector3();
  let yaw0 = 0;
  const ui: Record<string, HTMLElement> = {};
  const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
  return {
    duration: DUR,
    async setup() {
      S = stage();
      S.renderer.toneMapping = THREE.NoToneMapping;
      S.camera.fov = f.fov ?? 60;
      S.camera.updateProjectionMatrix();
      spark = new SparkRenderer({ renderer: S.renderer, maxStdDev: Math.sqrt(8) });
      S.scene.add(spark);
      const sc = await json(`/data/scenes/${f.scene}/scene.json`);
      const w = sc.world;
      const mesh = new SplatMesh({ url: `/data/scenes/${f.scene}/${w.file}` });
      await mesh.initialized;
      mesh.position.fromArray(w.transform.position);
      mesh.quaternion.fromArray(w.transform.quaternion);
      mesh.scale.setScalar(w.transform.scale);
      S.scene.add(mesh);
      spawn.fromArray(w.spawn?.position ?? [0, 0, 0]);
      yaw0 = w.spawn?.yaw ?? 0;
      (document.getElementById('shade') as HTMLElement).style.background =
        'linear-gradient(180deg, rgba(0,0,0,0) 72%, rgba(0,0,0,.55) 100%)';
      ui.name = el('', 120, 930, f.name);
      ui.name.style.cssText += 'font-size:34px;font-weight:600;letter-spacing:-0.015em;color:#f5f5f7';
      ui.made = el('', 120, 978, f.made);
      ui.made.style.cssText += 'font-size:24px;color:#a1a1a6;letter-spacing:-0.01em';
    },
    async frame(t) {
      const k = ease.sine(seg(t, 0, DUR));
      const p = (a?: number, b?: number) => lerp(a ?? 0, b ?? 0, k);
      const yaw = yaw0 + THREE.MathUtils.degToRad(p(f.from.yaw, f.to.yaw));
      const fwd = new THREE.Vector3(-Math.sin(yaw0), 0, -Math.cos(yaw0));
      const right = new THREE.Vector3(Math.cos(yaw0), 0, -Math.sin(yaw0));
      S.camera.position.copy(spawn).addScaledVector(right, p(f.from.x, f.to.x)).addScaledVector(fwd, p(f.from.z, f.to.z));
      S.camera.position.y = spawn.y + p(f.from.y, f.to.y);
      S.camera.rotation.order = 'YXZ';
      S.camera.rotation.set(THREE.MathUtils.degToRad(p(f.from.pitch, f.to.pitch)), yaw, 0);
      S.camera.updateMatrixWorld();
      reveal(ui.name, t, 0.6, 1.5);
      reveal(ui.made, t, 0.75, 1.65);
      for (const e of [ui.name, ui.made]) e.style.opacity = String(Number(e.style.opacity) * (1 - seg(t, DUR - 1.2, DUR - 0.4)));
      for (let n = 0; n < 40; n++) {
        S.renderer.render(S.scene, S.camera);
        await raf();
        if (!(spark as any).sorting && !(spark as any).sortDirty) break;
      }
      S.renderer.render(S.scene, S.camera);
    },
  };
}
