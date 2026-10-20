// The project thumbnail: the Quest 3S (the site's own model) floating in the Infinity Hall Game Lawn while the room
// builds itself out of it. The splat world stands behind, and the camera solve's coloured points stream out of the
// headset to their places in the room, the nearest still in flight. Rendered as a still: bun film/kit/render.ts
// thumbnail --still=0
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadQuestHeadset } from '../../../web/src/quest-model';
import { el, json, rng, stage, type Shot, BLUE } from '../lib';

let S: ReturnType<typeof stage>;
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

const shot: Shot = {
  duration: 1,
  async setup() {
    S = stage();
    S.renderer.toneMapping = THREE.NeutralToneMapping;
    S.camera.fov = 48;
    S.camera.updateProjectionMatrix();
    (document.getElementById('shade') as HTMLElement).style.background =
      'linear-gradient(180deg, rgba(0,0,0,0) 62%, rgba(0,0,0,.85) 84%)';

    // the room, from the fly-through's closing view
    const sc = await json('/data/scenes/the-courts/scene.json');
    const spawn = new THREE.Vector3().fromArray(sc.world.spawn?.position ?? [0, 0, 0]);
    const yaw0 = sc.world.spawn?.yaw ?? 0;
    const fwd = new THREE.Vector3(-Math.sin(yaw0), 0, -Math.cos(yaw0));
    const right = new THREE.Vector3(Math.cos(yaw0), 0, -Math.sin(yaw0));
    S.camera.position.copy(spawn).addScaledVector(right, 0.15).addScaledVector(fwd, -0.9);
    S.camera.position.y = spawn.y + 1.45;
    S.camera.rotation.order = 'YXZ';
    S.camera.rotation.set(THREE.MathUtils.degToRad(-4), yaw0 + THREE.MathUtils.degToRad(-8), 0);
    S.camera.updateMatrixWorld();
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(S.camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(S.camera.quaternion);

    // the headset, facing us a little turned, lit like the site's hero
    const pmrem = new THREE.PMREMGenerator(S.renderer);
    S.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    S.scene.environmentIntensity = 0.7;
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.copy(S.camera.position).addScaledVector(camUp, 2).addScaledVector(camFwd, -1).add(new THREE.Vector3(-1.5, 0, 0));
    S.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9cc8ff, 1.6);
    rim.position.copy(S.camera.position).addScaledVector(camFwd, 3).addScaledVector(camUp, 1);
    S.scene.add(rim);
    const hs = await loadQuestHeadset('/web/public/models/quest-3s.min.glb');
    const H = hs.group;
    H.scale.setScalar(0.1);
    const centre = S.camera.position.clone().addScaledVector(camFwd, 0.62).addScaledVector(camUp, 0.035);
    H.position.copy(centre);
    H.lookAt(S.camera.position);
    H.rotateY(THREE.MathUtils.degToRad(-24));
    H.rotateX(THREE.MathUtils.degToRad(6));
    S.scene.add(H);
    const gc = document.createElement('canvas');
    gc.width = gc.height = 512;
    const gx = gc.getContext('2d')!;
    const grad = gx.createRadialGradient(256, 256, 0, 256, 256, 256);
    grad.addColorStop(0, 'rgba(41,151,255,0.55)');
    grad.addColorStop(0.35, 'rgba(41,151,255,0.16)');
    grad.addColorStop(1, 'rgba(41,151,255,0)');
    gx.fillStyle = grad;
    gx.fillRect(0, 0, 512, 512);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(centre).addScaledVector(camFwd, 0.5);
    glow.scale.setScalar(1.6);
    S.scene.add(glow);

    // the build: every solved point flies from the headset to its place; the far room is done, the near is in flight
    const buf = await (await fetch('/film/assets/kit/points.bin')).arrayBuffer();
    const n = buf.byteLength / 16;
    const xyz = new Float32Array(buf, 0, n * 3);
    const rgb = new Uint8Array(buf, n * 12, n * 3);
    const rand = rng(7);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const p = new THREE.Vector3(), a = new THREE.Vector3(), c = new THREE.Vector3(), out = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
      const d = p.distanceTo(centre);
      // progress: settled when far, mid-flight when near (with some scatter so the stream has texture)
      const u = THREE.MathUtils.clamp((d - 1.2) / 5 + (rand() - 0.5) * 0.5, 0, 1);
      const k = 1 - Math.pow(1 - u, 2.4);
      // start just behind the visor's outline, so the front of the headset stays clean
      const ang = rand() * Math.PI * 2;
      a.copy(centre).addScaledVector(camFwd, 0.06 + rand() * 0.04)
        .add(new THREE.Vector3(Math.cos(ang) * 0.11, Math.sin(ang) * 0.06, 0).applyQuaternion(S.camera.quaternion));
      // a curved path: out of the visor first, then over to the point's place
      c.copy(a).addScaledVector(camFwd, 0.9 + rand() * 0.8).addScaledVector(camUp, 0.25 + rand() * 0.5);
      const t = k;
      out.copy(a).multiplyScalar((1 - t) * (1 - t)).addScaledVector(c, 2 * t * (1 - t)).addScaledVector(p, t * t);
      pos.set([out.x, out.y, out.z], i * 3);
      const mix = THREE.MathUtils.smoothstep(t, 0.5, 0.97); // in flight: white-hot into blue; settled: the room's colour
      const hot = new THREE.Color(0xffffff).lerp(new THREE.Color(BLUE), THREE.MathUtils.smoothstep(t, 0.0, 0.45));
      const dim = 0.8;
      col.set([THREE.MathUtils.lerp(hot.r, dim * rgb[i * 3] / 255, mix), THREE.MathUtils.lerp(hot.g, dim * rgb[i * 3 + 1] / 255, mix),
        THREE.MathUtils.lerp(hot.b, dim * rgb[i * 3 + 2] / 255, mix)], i * 3);
      size[i] = 1.3 + 2.6 * (1 - t) * (0.5 + rand());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('psize', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 color; attribute float psize; varying vec3 vC;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = min(psize * (2.2 / -mv.z), 7.0); }`,
      fragmentShader: `varying vec3 vC; void main(){ vec2 q = gl_PointCoord - 0.5; float r = length(q);
        if (r > 0.5) discard; gl_FragColor = vec4(vC, smoothstep(0.5, 0.0, r) * 0.9); }`,
    });
    S.scene.add(new THREE.Points(g, m));

    // the words
    const t1 = el('', 0, 812, 'Deja View');
    t1.style.cssText += 'width:1920px;text-align:center;font-size:118px;font-weight:700;letter-spacing:-0.035em;color:#f5f5f7';
    const t2 = el('', 0, 950, 'Anything you capture, you can walk into.');
    t2.style.cssText += 'width:1920px;text-align:center;font-size:38px;font-weight:500;letter-spacing:-0.01em;color:#c7c7cc';
    const t3 = el('', 0, 1008, 'deja-view.photo');
    t3.style.cssText += `width:1920px;text-align:center;font-size:28px;font-weight:500;color:${BLUE}`;
  },

  async frame() {
    await raf();
    S.renderer.render(S.scene, S.camera);
  },
};

export default shot;
