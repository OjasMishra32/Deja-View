// Third person on screen: your own avatar (a GLB, e.g. a Roblox avatar exported from Studio) walks through the world
// and the camera follows behind it, pulled in so it never ends up inside a wall. Headset sessions stay first person.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** How tall the avatar stands (metres), whatever units its file uses. */
const AVATAR_HEIGHT = 1.75;
/** Camera distance behind the head, and how far above it the camera rides. */
const FOLLOW_DIST = 3.1;
const FOLLOW_UP = 0.35;
const HEAD = 1.55;
/** How quickly the avatar turns to face where it walks (1/s). */
const TURN = 10;

export interface SolidTest {
  solidAt(x: number, y: number, z: number): boolean;
}

export class ThirdPerson {
  readonly root = new THREE.Group();
  private body: THREE.Object3D | null = null;
  private facing = 0;
  private walkT = 0;
  private dist = FOLLOW_DIST;
  ready: Promise<boolean>;

  /** `forwardYaw`: the turn that makes the model face -Z (a Roblox export faces -Z already, so 0). */
  constructor(url: string, parent: THREE.Object3D, forwardYaw = 0) {
    this.root.name = 'third-person-avatar';
    this.root.visible = false;
    parent.add(this.root);
    this.ready = new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const s = size.y > 0 ? AVATAR_HEIGHT / size.y : 1;
        model.scale.setScalar(s);
        // feet on the origin, centred
        const c = box.getCenter(new THREE.Vector3());
        model.position.set(-c.x * s, -box.min.y * s, -c.z * s);
        const holder = new THREE.Group();
        holder.rotation.y = forwardYaw;
        holder.add(model);
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.frustumCulled = false;
        });
        this.body = holder;
        this.root.add(holder);
        this.root.visible = true;
        return true;
      })
      .catch((e) => {
        console.warn('[third-person] avatar did not load', e);
        return false;
      });
  }

  get loaded(): boolean {
    return this.body !== null;
  }

  /**
   * Places the avatar at the walker's feet and the camera behind it. `yaw`/`pitch` are the look angles (the camera
   * orbits with them); the avatar turns to face the way it moves, like a Roblox character. Writes the camera pose
   * into `rig` (position) and `camera` (rotation), the same objects first person uses.
   */
  update(dt: number, feet: { x: number; y: number; z: number }, vel: { x: number; z: number }, yaw: number, pitch: number,
    rig: THREE.Object3D, camera: THREE.Camera, solid: SolidTest | null): void {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 0.15) {
      const want = Math.atan2(-vel.x, -vel.z);
      let d = want - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, TURN * dt);
      this.walkT += dt * (4 + speed * 2.5);
    } else {
      this.walkT = 0;
    }
    const bob = speed > 0.15 ? Math.abs(Math.sin(this.walkT)) * 0.045 : 0;
    this.root.position.set(feet.x, feet.y + bob, feet.z);
    this.root.rotation.set(0, this.facing, speed > 0.15 ? Math.sin(this.walkT) * 0.035 : 0);

    // the camera: behind the head along the look direction, pulled in where the world is solid
    const head = new THREE.Vector3(feet.x, feet.y + HEAD, feet.z);
    const back = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    let want = FOLLOW_DIST;
    if (solid) {
      for (let s = 0.3; s <= FOLLOW_DIST; s += 0.15) {
        const p = head.clone().addScaledVector(back, s);
        if (solid.solidAt(p.x, p.y + FOLLOW_UP, p.z)) {
          want = Math.max(0.6, s - 0.35);
          break;
        }
      }
    }
    this.dist += (want - this.dist) * Math.min(1, (want < this.dist ? 18 : 4) * dt);
    rig.position.copy(head).addScaledVector(back, this.dist);
    rig.position.y += FOLLOW_UP;
    rig.rotation.set(0, yaw, 0);
    camera.position.set(0, 0, 0);
    // look slightly down at the head from above
    camera.rotation.set(pitch - Math.atan2(FOLLOW_UP, this.dist), 0, 0);
  }

  setVisible(on: boolean): void {
    this.root.visible = on && this.loaded;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
