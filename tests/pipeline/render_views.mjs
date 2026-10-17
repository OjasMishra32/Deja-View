// Headless check of a pipeline splat world: renders a few viewpoints with three.js + Spark in
// Chrome and saves PNGs, so a room can be looked at without the full viewer.
//
//   bun tests/pipeline/render_views.mjs <scene_or_out_dir> <png_dir> [extra.ply ...]
//
// Reads scene.json (Scene or JobResult) for world.file / world.transform / floorY. Extra PLYs
// (for example a lifted video frame) are drawn in the viewer frame without a transform.
// No server is started: page requests are answered from disk through Playwright routing.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";

const root = resolve(import.meta.dir ?? new URL(".", import.meta.url).pathname, "../..");
const [sceneDirArg, outDirArg, ...extras] = process.argv.slice(2);
if (!sceneDirArg || !outDirArg) {
  console.error("usage: bun tests/pipeline/render_views.mjs <scene_or_out_dir> <png_dir> [extra.ply ...]");
  process.exit(2);
}
const sceneDir = resolve(sceneDirArg);
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });
const meta = JSON.parse(readFileSync(join(sceneDir, "scene.json"), "utf8"));
const world = meta.world;
const floorY = world.floorY ?? -1.25;
const eye = floorY + 1.6;

// name, position, yaw (deg, 0 = looking down -Z, positive turns left), pitch (deg)
const views = [
  ["camera", [0, 0, 0], 0, 0],
  ["spawn-eye", [0, eye, 0.3], 0, -12],
  ["step-left", [-0.8, eye, -0.2], -20, -12],
  ["step-right", [0.8, eye, -0.2], 20, -12],
  ["walk-in", [0.2, eye, -1.0], 10, -20],
  ["turn-left", [0, eye, 0], 90, -5],
  ["turn-back", [0, eye, 0], 180, -5],
  ["corner", [1.1, eye + 0.4, 1.4], 25, -22],
  ["low-left", [-1.0, floorY + 1.0, -0.6], -35, -8],
];

const mime = { ".js": "text/javascript", ".html": "text/html", ".ply": "application/octet-stream", ".spz": "application/octet-stream", ".json": "application/json" };
const files = {
  "/three/three.module.js": join(root, "node_modules/three/build/three.module.js"),
  "/three/three.core.js": join(root, "node_modules/three/build/three.core.js"),
  "/spark/spark.module.js": join(root, "node_modules/@sparkjsdev/spark/dist/spark.module.js"),
  ["/scene/" + world.file]: join(sceneDir, world.file),
};
extras.forEach((p, i) => (files[`/extra/${i}${extname(p)}`] = resolve(p)));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/three-addons/","@sparkjsdev/spark":"/spark/spark.module.js"}}</script></head>
<body><script type="module">
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
const W = 960, H = 540;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(1);
renderer.setClearColor(0x202020);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const spark = new SparkRenderer({ renderer });
scene.add(spark);
const camera = new THREE.PerspectiveCamera(70, W / H, 0.02, 200);
const world = ${JSON.stringify(world)};
const mesh = new SplatMesh({ url: "/scene/" + world.file });
const t = world.transform;
mesh.position.set(...t.position); mesh.quaternion.set(...t.quaternion); mesh.scale.setScalar(t.scale);
scene.add(mesh);
const extras = ${JSON.stringify(extras.map((p, i) => `/extra/${i}${extname(p)}`))}.map((u) => { const m = new SplatMesh({ url: u }); scene.add(m); return m; });
await Promise.all([mesh.initialized, ...extras.map((m) => m.initialized)]);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.setView = (p, yaw, pitch) => {
  camera.position.set(...p);
  camera.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0, "YXZ");
};
window.ready = true;
</script></body></html>`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
const note = (t) => { logs.push(t); if (process.env.RENDER_DEBUG) console.error(t); };
page.on("console", (m) => note(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => note(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => note(`requestfailed: ${r.url()}`));
await page.route("http://tw.local/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/" || url.pathname === "/index.html") return route.fulfill({ status: 200, contentType: "text/html", body: html });
  let f = files[url.pathname];
  if (!f && url.pathname.startsWith("/three-addons/")) {
    const rel = url.pathname.slice("/three-addons/".length);
    if (!rel.includes("..")) f = join(root, "node_modules/three/examples/jsm", rel);
  }
  if (!f || !existsSync(f)) { note(`404 ${url.pathname}`); return route.fulfill({ status: 404, body: "not found" }); }
  return route.fulfill({ status: 200, contentType: mime[extname(f)] ?? "application/octet-stream", body: readFileSync(f) });
});
await page.goto("http://tw.local/");
try {
  await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
} catch (e) {
  console.error(logs.join("\n"));
  await browser.close();
  throw e;
}
for (const [name, p, yaw, pitch] of views) {
  await page.evaluate(([p, yaw, pitch]) => window.setView(p, yaw, pitch), [p, yaw, pitch]);
  await page.waitForTimeout(1200);
  const png = join(outDir, `${name}.png`);
  await page.locator("canvas").screenshot({ path: png });
  console.log(png);
}
writeFileSync(join(outDir, "console.txt"), logs.join("\n"));
await browser.close();
