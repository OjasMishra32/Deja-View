// Headless turntable of a video memory's full-3D people inside their splat world: three.js + Spark in Chrome, the
// people's GLBs (pipeline/avatar) posed at one moment of their 'video' clip, as the viewer shows them (unlit
// texture, at identity in the viewer frame), seen from a ring of cameras around them.
//
//   bun tests/pipeline/render_people.mjs <scene_dir> <png_dir> <t_seconds> <views> <avatar-0.glb> [avatar-1.glb ...]
//
// The ring is centred on the people's pelvises at t (floor plane), RING_R metres (default: 2 + their spread)
// out, at eye height RING_Y (1.75) looking at 0.95 m. Writes view-<i>.png (i = 0 .. views-1, yaw = 360 i / views,
// yaw 0 looking along -z) and ring.json (centre, radius, pelvises). No server: page requests are answered from disk.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const root = resolve(import.meta.dir ?? new URL(".", import.meta.url).pathname, "../..");
const [sceneDirArg, outDirArg, tArg, viewsArg, ...glbs] = process.argv.slice(2);
if (!sceneDirArg || !outDirArg || !glbs.length) {
  console.error("usage: bun tests/pipeline/render_people.mjs <scene_dir> <png_dir> <t_seconds> <views> <avatar-0.glb> [...]");
  process.exit(2);
}
const sceneDir = resolve(sceneDirArg);
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });
const t = Number(tArg ?? 6);
const views = Number(viewsArg ?? 12);
const W = Number(process.env.RENDER_W ?? 960), H = Number(process.env.RENDER_H ?? 640);
const meta = JSON.parse(readFileSync(join(sceneDir, "scene.json"), "utf8"));
const world = meta.world;

const mime = { ".js": "text/javascript", ".html": "text/html", ".spz": "application/octet-stream", ".glb": "model/gltf-binary" };
const files = {
  "/three/three.module.js": join(root, "node_modules/three/build/three.module.js"),
  "/three/three.core.js": join(root, "node_modules/three/build/three.core.js"),
  "/spark/spark.module.js": join(root, "node_modules/@sparkjsdev/spark/dist/spark.module.js"),
  ["/scene/" + world.file]: join(sceneDir, world.file),
};
glbs.forEach((p, i) => (files[`/people/${i}.glb`] = resolve(p)));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/three-addons/","@sparkjsdev/spark":"/spark/spark.module.js"}}</script></head>
<body><script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
const W = ${W}, H = ${H};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x202020);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const spark = new SparkRenderer({ renderer });
scene.add(spark);
const camera = new THREE.PerspectiveCamera(50, W / H, 0.02, 200);
const world = ${JSON.stringify(world)};
const mesh = new SplatMesh({ url: "/scene/" + world.file });
const tr = world.transform;
mesh.position.set(...tr.position); mesh.quaternion.set(...tr.quaternion); mesh.scale.setScalar(tr.scale);
scene.add(mesh);
const loader = new GLTFLoader();
const people = await Promise.all(${JSON.stringify(glbs.map((_, i) => `/people/${i}.glb`))}.map((u) => loader.loadAsync(u)));
const pelvis = [];
for (const g of people) {
  scene.add(g.scene);
  g.scene.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(g.scene);
  const clip = g.animations.find((a) => a.name === "video") ?? g.animations[0];
  mixer.clipAction(clip).play();
  mixer.setTime(${t});
  g.scene.updateMatrixWorld(true);
  const r = g.scene.getObjectByName("root");
  pelvis.push(r.getWorldPosition(new THREE.Vector3()).toArray());
}
await mesh.initialized;
renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.pelvis = pelvis;
window.setView = (eye, target) => { camera.position.set(...eye); camera.lookAt(...target); };
window.ready = true;
</script></body></html>`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.route("http://tw.local/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/" || url.pathname === "/index.html") return route.fulfill({ status: 200, contentType: "text/html", body: html });
  let f = files[url.pathname];
  if (!f && url.pathname.startsWith("/three-addons/")) {
    const rel = url.pathname.slice("/three-addons/".length);
    if (!rel.includes("..")) f = join(root, "node_modules/three/examples/jsm", rel);
  }
  if (!f || !existsSync(f)) { logs.push(`404 ${url.pathname}`); return route.fulfill({ status: 404, body: "not found" }); }
  return route.fulfill({ status: 200, contentType: mime[extname(f)] ?? "application/octet-stream", body: readFileSync(f) });
});
await page.goto("http://tw.local/");
try {
  await page.waitForFunction("window.ready === true", null, { timeout: 180000 });
} catch (e) {
  console.error(logs.join("\n"));
  await browser.close();
  throw e;
}
const pel = await page.evaluate(() => window.pelvis);
const cx = pel.reduce((s, p) => s + p[0], 0) / pel.length, cz = pel.reduce((s, p) => s + p[2], 0) / pel.length;
const spread = Math.max(...pel.map((p) => Math.hypot(p[0] - cx, p[2] - cz)));
const radius = Number(process.env.RING_R ?? 2.0 + spread);
const eyeY = Number(process.env.RING_Y ?? 1.75), lookY = Number(process.env.LOOK_Y ?? 0.95);
for (let i = 0; i < views; i++) {
  const a = (2 * Math.PI * i) / views;
  const eye = [cx + radius * Math.sin(a), eyeY, cz + radius * Math.cos(a)];
  await page.evaluate(([e, tg]) => window.setView(e, tg), [eye, [cx, lookY, cz]]);
  await page.waitForTimeout(1500);
  const png = join(outDir, `view-${String(i).padStart(2, "0")}.png`);
  await page.locator("canvas").screenshot({ path: png });
  console.log(png);
}
writeFileSync(join(outDir, "ring.json"), JSON.stringify({ t, views, centre: [cx, cz], radius, eyeY, lookY, pelvis: pel }, null, 1));
writeFileSync(join(outDir, "console.txt"), logs.join("\n"));
await browser.close();
