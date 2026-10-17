// What the backdrop (web/src/viewer/backdrop.ts) fixes, measured in headless Chrome against a running viewer server.
//
//   bun tests/harness/backdrop-probe.ts <scene> [--base=http://localhost:8873] [--out=data/evidence/backdrop]
//        [--spacing=2] [--size=480x300] [--settle=700] [--perf=only|no] [--perf-seconds=6]
//
// Coverage: standing spots on a grid over world.bounds that a walker can reach from the spawn (the viewer's own
// collider, eye height 1.6 m), 8 yaws x pitch 0 / +40 / +70. Each view is drawn in one frame four more times with the
// sky replaced by two key colours: the difference gives every pixel's coverage alpha exactly (difference matting).
// A void pixel has alpha < 0.5. "before" = the splats alone (what the viewer drew before: its gradient sky shows
// through), "after" = the splats over the backdrop room (its sky image then fills what is left). Also counted: black
// pixels (luma < 16/255) in the normal render. Contact sheets per pitch (rows = spots, columns = yaws) go to
// <out>/<scene>/{before,after}/pitch<p>.jpg, the same with void pixels in magenta to pitch<p>-voids.jpg.
//
// Perf: the emulated Quest (?xremu=1, a Quest user agent, so the headset's splat settings and level of detail),
// in VR, frame interval and main-thread time with and without the backdrop, alternating, at three head poses.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
const SCENE = args.find((a) => !a.startsWith('--')) ?? 'the-courts';
const BASE = flag('base', 'http://localhost:8873');
const OUT = resolve(ROOT, flag('out', 'data/evidence/backdrop'), SCENE);
const SPACING = Number(flag('spacing', '2'));
const [W, H] = flag('size', '480x300').split('x').map(Number) as [number, number];
const SETTLE = Number(flag('settle', '700'));
const PERF = flag('perf', 'yes');
const PERF_S = Number(flag('perf-seconds', '6'));
const PITCHES = [0, 40, 70];
const YAWS = 8;
const QUEST_UA =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36';

mkdirSync(join(OUT, 'before'), { recursive: true });
mkdirSync(join(OUT, 'after'), { recursive: true });

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${BASE}/view?scene=${encodeURIComponent(SCENE)}&intro=0&dpr=1&narrate=never&labelsDelay=100000${query}`);
  await page.waitForFunction(() => (window as any).__viewer?.ready || (window as any).__viewer?.error, null, { timeout: 180_000 });
  const err = await page.evaluate(() => (window as any).__viewer.error);
  if (err) throw new Error(`viewer: ${err}`);
  // the backdrop loads next to the world; the reveal takes 2.6 s
  await page.waitForFunction(() => !!(window as any).__viewerBackdrop || (window as any).__viewer.info.backdrop?.error, null, { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(3500);
}

/** Reachable standing spots: a 0.25 m flood fill from the spawn over the viewer's collider, sampled every SPACING m. */
async function spots(page: Page): Promise<{ x: number; y: number; z: number }[]> {
  return page.evaluate((spacing) => {
    const app = (window as any).__viewerApp;
    const world = app.world;
    const a = app.analysis;
    const wb = app.data.world.bounds ?? a.bounds;
    const floor = a.floorY;
    const b = { min: [wb.min[0], wb.min[1] - floor, wb.min[2]], max: [wb.max[0], wb.max[1] - floor, wb.max[2]] };
    const cell = 0.25, r = 0.25;
    const pen = { x: 0, z: 0, depth: 0 };
    const nx = Math.ceil((b.max[0] - b.min[0]) / cell) + 1, nz = Math.ceil((b.max[2] - b.min[2]) / cell) + 1;
    const ground = new Float32Array(nx * nz).fill(NaN);
    const seen = new Uint8Array(nx * nz);
    const fits = (x: number, z: number, from: number): number | null => {
      const g = world.groundAt(x, z, from + 0.4, from - 0.6);
      if (g === null || Math.abs(g - from) > 0.4) return null;
      if (world.penetration(x, z, r, g + 0.4, g + 1.75, pen)) return null;
      return g;
    };
    const sx = Math.round((a.spawn.x - b.min[0]) / cell), sz = Math.round((a.spawn.z - b.min[2]) / cell);
    const queue: number[] = [];
    const start = sz * nx + sx;
    if (sx >= 0 && sx < nx && sz >= 0 && sz < nz) {
      const g = fits(b.min[0] + sx * cell, b.min[2] + sz * cell, a.spawn.y);
      ground[start] = g ?? a.spawn.y;
      seen[start] = 1;
      queue.push(start);
    }
    while (queue.length) {
      const k = queue.shift()!;
      const ix = k % nx, iz = (k - ix) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const j = jz * nx + jx;
        if (seen[j]) continue;
        const g = fits(b.min[0] + jx * cell, b.min[2] + jz * cell, ground[k]!);
        if (g === null) continue;
        seen[j] = 1;
        ground[j] = g;
        queue.push(j);
      }
    }
    const out: { x: number; y: number; z: number }[] = [];
    for (let z = b.min[2] + spacing / 2; z <= b.max[2]; z += spacing) {
      for (let x = b.min[0] + spacing / 2; x <= b.max[0]; x += spacing) {
        // the reachable cell nearest the grid point, within 0.6 m
        let best = -1, bd = 0.6;
        for (let k = 0; k < seen.length; k++) {
          if (!seen[k]) continue;
          const ix = k % nx, iz = (k - ix) / nx;
          const d = Math.hypot(b.min[0] + ix * cell - x, b.min[2] + iz * cell - z);
          if (d < bd) { bd = d; best = k; }
        }
        if (best < 0) continue;
        const ix = best % nx, iz = (best - ix) / nx;
        out.push({ x: b.min[0] + ix * cell, y: ground[best]!, z: b.min[2] + iz * cell });
      }
    }
    return out;
  }, SPACING);
}

interface ViewStats { before: { void: number; uncovered: number; black: number }; after: { void: number; uncovered: number; black: number } }

async function measure(page: Page, spot: { x: number; y: number; z: number }, row: number, nrows: number): Promise<ViewStats[]> {
  const out: ViewStats[] = [];
  for (let pi = 0; pi < PITCHES.length; pi++) {
    for (let yi = 0; yi < YAWS; yi++) {
      const yaw = (yi / YAWS) * Math.PI * 2;
      const pitch = (PITCHES[pi]! * Math.PI) / 180;
      await page.evaluate(([s, yw, p]) => {
        const app = (window as any).__viewerApp;
        app.player.place(s.x, s.y, s.z, yw, p);
      }, [spot, yaw, pitch] as const);
      // Spark sorts for the new view on its worker over the next frames
      await page.waitForTimeout(SETTLE);
      const r = await page.evaluate(([s, yw, p, row, col, sheet, nrows, w, h]) => {
        const app = (window as any).__viewerApp;
        const bd = (window as any).__viewerBackdrop;
        const renderer = app.renderer;
        const gl = renderer.getContext() as WebGL2RenderingContext;
        app.player.place(s.x, s.y, s.z, yw, p);
        app.rig.position.set(s.x, s.y + app.player.eyeHeight, s.z);
        app.rig.rotation.set(0, yw, 0);
        app.camera.position.set(0, 0, 0);
        app.camera.rotation.set(p, 0, 0);
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const read = () => {
          renderer.render(app.scene, app.camera);
          const px = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        const K1 = [1, 0, 1], K2 = [0, 1, 0];
        const keyed = () => {
          app.sky.mesh.visible = false;
          renderer.setClearColor(0xff00ff, 1);
          const a = read();
          renderer.setClearColor(0x00ff00, 1);
          const b = read();
          renderer.setClearColor(0x0c0c0e, 1);
          app.sky.mesh.visible = true;
          // alpha from the two keys: c = s + (1 - a) k
          const n = W * H;
          const alpha = new Float32Array(n);
          const den = (K1[0]! - K2[0]!) ** 2 + (K1[1]! - K2[1]!) ** 2 + (K1[2]! - K2[2]!) ** 2;
          for (let i = 0; i < n; i++) {
            let num = 0;
            for (let c = 0; c < 3; c++) num += ((a[i * 4 + c]! - b[i * 4 + c]!) / 255) * (K1[c]! - K2[c]!);
            alpha[i] = Math.min(1, Math.max(0, 1 - num / den));
          }
          return alpha;
        };
        const stats = (img: Uint8Array, alpha: Float32Array) => {
          let v = 0, u = 0, k = 0;
          const n = W * H;
          for (let i = 0; i < n; i++) {
            if (alpha[i]! < 0.5) v++;
            u += 1 - alpha[i]!;
            const l = 0.2126 * img[i * 4]! + 0.7152 * img[i * 4 + 1]! + 0.0722 * img[i * 4 + 2]!;
            if (l < 16) k++;
          }
          return { void: v / n, uncovered: u / n, black: k / n };
        };
        // before: no backdrop
        bd.enabled = false; bd.update();
        const imgA = read();
        const alA = keyed();
        // after: room + sky image; coverage of splats + room (the sky image fills the rest)
        bd.enabled = true; bd.roomOn = true; bd.skyOn = true; bd.update();
        const imgB = read();
        bd.skyOn = false; bd.update();
        const alB = keyed();
        bd.skyOn = true; bd.update();
        // contact sheet tiles
        const g = window as any;
        g.__sheets ??= {};
        const tw = 160, th = Math.round((160 * H) / W);
        const tile = (name: string, img: Uint8Array, alpha: Float32Array | null) => {
          let sh = g.__sheets[name];
          if (!sh) {
            sh = document.createElement('canvas');
            sh.width = tw * 8;
            sh.height = th * nrows;
            g.__sheets[name] = sh;
          }
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const ctx = c.getContext('2d')!;
          const id = ctx.createImageData(W, H);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = ((H - 1 - y) * W + x) * 4, o = (y * W + x) * 4;
              const isVoid = alpha && alpha[(H - 1 - y) * W + x]! < 0.5;
              id.data[o] = isVoid ? 255 : img[i]!;
              id.data[o + 1] = isVoid ? 0 : img[i + 1]!;
              id.data[o + 2] = isVoid ? 255 : img[i + 2]!;
              id.data[o + 3] = 255;
            }
          }
          ctx.putImageData(id, 0, 0);
          sh.getContext('2d').drawImage(c, col * tw, row * th, tw, th);
        };
        tile(`before/pitch${sheet}`, imgA, null);
        tile(`before/pitch${sheet}-voids`, imgA, alA);
        tile(`after/pitch${sheet}`, imgB, null);
        tile(`after/pitch${sheet}-voids`, imgB, alB);
        return { before: stats(imgA, alA), after: stats(imgB, alB) };
      }, [spot, yaw, pitch, row, yi, PITCHES[pi]!, nrows, W, H] as const);
      out.push(r);
    }
  }
  return out;
}

async function coverage(): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' || /backdrop/.test(m.text())) errors.push(m.text());
    });
    await open(page, '');
    const info = await page.evaluate(async (scene) => {
      // which sky image this run measured (other pipelines may replace backdrop-sky.jpg)
      const bd = (window as any).__viewer.info.backdrop;
      let skySha1: string | null = null;
      try {
        const m = await (await fetch(`/data/scenes/${scene}/backdrop.json`, { cache: 'no-store' })).json();
        if (m.sky) {
          const buf = await (await fetch(`/data/scenes/${scene}/${m.sky}`)).arrayBuffer();
          skySha1 = [...new Uint8Array(await crypto.subtle.digest('SHA-1', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
        }
      } catch {
        /* named in scene.json instead */
      }
      return { backdrop: bd ? { ...bd, skySha1 } : bd, spawn: (window as any).__viewer.info.spawn };
    }, SCENE);
    console.log('backdrop', JSON.stringify(info.backdrop));
    if (!info.backdrop || info.backdrop.error) throw new Error(`no backdrop in ${SCENE}`);
    // fly: no gravity or step-up between the placements and the frozen renders
    await page.evaluate(() => (window as any).__viewerApp.player.setFly(true));
    const list = await spots(page);
    console.log(`${list.length} reachable spots`);
    const perView: (ViewStats & { spot: number; yaw: number; pitch: number })[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      const r = await measure(page, s, i, list.length);
      r.forEach((v, k) => perView.push({ ...v, spot: i, yaw: (k % YAWS) * (360 / YAWS), pitch: PITCHES[Math.floor(k / YAWS)]! }));
      const m = (key: 'before' | 'after') => (r.reduce((a, v) => a + v[key].void, 0) / r.length * 100).toFixed(1);
      console.log(`spot ${i} (${s.x.toFixed(1)}, ${s.z.toFixed(1)}): void ${m('before')}% -> ${m('after')}%`);
    }
    const sheets = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const [k, c] of Object.entries((window as any).__sheets as Record<string, HTMLCanvasElement>)) out[k] = c.toDataURL('image/jpeg', 0.82);
      return out;
    });
    for (const [k, url] of Object.entries(sheets)) writeFileSync(join(OUT, `${k}.jpg`), Buffer.from(url.split(',')[1]!, 'base64'));
    const agg = (views: typeof perView, key: 'before' | 'after') => {
      const n = Math.max(1, views.length);
      const mean = (f: (v: ViewStats['before']) => number) => Math.round((views.reduce((a, v) => a + f(v[key]), 0) / n) * 1e4) / 1e2;
      return {
        voidPct: mean((v) => v.void),
        uncoveredPct: mean((v) => v.uncovered),
        blackPct: mean((v) => v.black),
        viewsWithVoidOver1Pct: Math.round((views.filter((v) => v[key].void > 0.01).length / n) * 1e4) / 1e2,
      };
    };
    const byPitch: Record<string, unknown> = {};
    for (const p of PITCHES) {
      const v = perView.filter((x) => x.pitch === p);
      byPitch[`pitch${p}`] = { before: agg(v, 'before'), after: agg(v, 'after') };
    }
    return {
      scene: SCENE,
      viewport: [W, H],
      spots: list,
      views: perView.length,
      all: { before: agg(perView, 'before'), after: agg(perView, 'after') },
      byPitch,
      backdrop: info.backdrop,
      errors,
      perView,
    };
  } finally {
    await browser.close();
  }
}

async function perf(): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, userAgent: QUEST_UA });
    const page = await context.newPage();
    await open(page, '&xremu=1');
    await page.click('#tw-btn-vr');
    await page.waitForFunction(() => (window as any).__viewerApp?.renderer.xr.isPresenting, null, { timeout: 30_000 });
    await page.waitForTimeout(2000);
    const settings = await page.evaluate(() => {
      const app = (window as any).__viewerApp;
      const gl = app.renderer.getContext();
      return { ua: navigator.userAgent, lod: (window as any).__viewer.info.lod, maxStdDev: app.spark.maxStdDev, framebuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
    });
    const poses = [
      { name: 'ahead', pitch: 0, yaw: 0 },
      { name: 'up40', pitch: 40, yaw: 0 },
      { name: 'behind-up40', pitch: 40, yaw: 180 },
    ];
    // hold the headset's splat settings at its default level: the governor would otherwise step them while we compare
    await page.evaluate(() => {
      const app = (window as any).__viewerApp;
      app.xrGovernor.push = () => null;
      app.applyXrLevel(0);
    });
    const rows: Record<string, unknown>[] = [];
    for (const pose of poses) {
      const r = await page.evaluate(async ([p, seconds]) => {
        const app = (window as any).__viewerApp;
        const bd = (window as any).__viewerBackdrop;
        const dev = (window as any).__xrDevice;
        const v = (window as any).__viewer;
        const yaw = (p.yaw * Math.PI) / 180, pitch = (p.pitch * Math.PI) / 180;
        // yaw about Y, then pitch about the local X
        const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
        dev.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
        await new Promise((r) => setTimeout(r, 2000));
        const gl = app.renderer.getContext() as WebGL2RenderingContext;
        const px = new Uint8Array(4);
        const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1]!;
        // 1) both eyes drawn synchronously (readPixels waits for the GPU), blocks of 8 alternating on / off
        const sync: Record<string, number[]> = { on: [], off: [] };
        for (let block = 0; block < 6; block++) {
          const on = block % 2 === 0;
          bd.enabled = on;
          bd.update();
          app.renderer.render(app.scene, app.camera);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let i = 0; i < 8; i++) {
            const t0 = performance.now();
            app.renderer.render(app.scene, app.camera);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            sync[on ? 'on' : 'off']!.push(performance.now() - t0);
          }
        }
        // 2) the running loop's frame interval and main-thread time
        const loop: Record<string, { frame: number[]; cpu: number[] }> = { on: { frame: [], cpu: [] }, off: { frame: [], cpu: [] } };
        for (let block = 0; block < 4; block++) {
          const on = block % 2 === 0;
          bd.enabled = on;
          await new Promise((r) => setTimeout(r, 1200));
          const t0 = performance.now();
          while (performance.now() - t0 < (seconds * 1000) / 2) {
            await new Promise((r) => setTimeout(r, 500));
            loop[on ? 'on' : 'off']!.frame.push(v.stats.frameMs);
            loop[on ? 'on' : 'off']!.cpu.push(v.stats.cpuMs);
          }
        }
        bd.enabled = true;
        const r2 = (x: number) => Math.round(x * 100) / 100;
        return {
          syncMs: { with: r2(median(sync.on!)), without: r2(median(sync.off!)) },
          frameMs: { with: r2(median(loop.on!.frame)), without: r2(median(loop.off!.frame)) },
          cpuMs: { with: r2(median(loop.on!.cpu)), without: r2(median(loop.off!.cpu)) },
          xrLevel: v.info.xrPerf,
        };
      }, [pose, PERF_S] as const);
      rows.push({ pose: pose.name, ...r });
      console.log(pose.name, JSON.stringify(r));
    }
    const summary: Record<string, unknown> = {};
    for (const k of ['syncMs', 'frameMs', 'cpuMs'] as const) {
      const mean = (w: 'with' | 'without') => Math.round((rows.reduce((a, x) => a + (x as any)[k][w], 0) / rows.length) * 100) / 100;
      summary[k] = { with: mean('with'), without: mean('without') };
    }
    return { settings, rows, summary };
  } finally {
    await browser.close();
  }
}

// each phase lands in report.json as soon as it is done (a run of one phase keeps the other's results)
const reportFile = join(OUT, 'report.json');
let report: Record<string, unknown> = { scene: SCENE, base: BASE };
try {
  report = { ...JSON.parse(readFileSync(reportFile, 'utf8')), scene: SCENE, base: BASE };
} catch {
  /* first run */
}
if (PERF !== 'only') {
  report.coverage = await coverage();
  writeFileSync(reportFile, JSON.stringify(report, null, 1));
}
if (PERF !== 'no') {
  report.perf = await perf();
  writeFileSync(reportFile, JSON.stringify(report, null, 1));
}
const cov = report.coverage as { all?: unknown; byPitch?: unknown } | undefined;
console.log(JSON.stringify({ all: cov?.all, byPitch: cov?.byPitch, perf: (report.perf as { summary?: unknown } | undefined)?.summary }, null, 1));
console.log(`report and sheets in ${OUT}`);
