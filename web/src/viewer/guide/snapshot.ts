// What the person is looking at, as a JPEG data URL for the guide.
//
// Desktop and WebXR use the same path: inside the frame loop, the scene is drawn once more from a
// mono camera at the head pose into a small render target, read back without stalling (a pixel
// buffer plus a fence), flipped and encoded off the frame loop. In XR the XR framebuffer is left
// bound exactly as three.js had it, so the headset frame is not disturbed.
//
// The render target is flagged as an "XR render target" so three.js and Spark write sRGB into it
// exactly like the screen: no linear-to-sRGB pass and, more importantly, no extra shader variants
// to compile the first time a snapshot is taken. Its storage is plain RGBA8 so the bytes read back
// are the bytes the screen would show.

import * as THREE from 'three';

export interface Snapshot {
  /** data:image/jpeg;base64,... */
  image: string;
  width: number;
  height: number;
  /** The camera the picture was taken with; its world and projection matrices are frozen. */
  camera: THREE.PerspectiveCamera;
  /** performance.now() at capture. */
  takenAt: number;
  /** Whether it was taken in the headset. */
  xr: boolean;
}

export interface SnapshotOptions {
  /** Image width in pixels (contracts 8: about 1024 x 768). */
  width: number;
  /** Aspect (width / height) in the headset. */
  xrAspect: number;
  /** Vertical field of view in the headset, degrees. */
  xrFov: number;
  /** Desktop aspect is the window's, clamped to this range. */
  minAspect: number;
  maxAspect: number;
  /** JPEG quality 0..1. */
  quality: number;
  /** Give up on a snapshot after this long (ms). */
  timeoutMs: number;
}

export const DEFAULT_SNAPSHOT: SnapshotOptions = { width: 1024, xrAspect: 4 / 3, xrFov: 78, minAspect: 1, maxAspect: 1.8, quality: 0.82, timeoutMs: 5000 };

/** Pixel size for a view of the given aspect: `width` wide, even height. */
export function snapshotSize(aspect: number, width = DEFAULT_SNAPSHOT.width, minAspect = DEFAULT_SNAPSHOT.minAspect, maxAspect = DEFAULT_SNAPSHOT.maxAspect): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? Math.min(maxAspect, Math.max(minAspect, aspect)) : 4 / 3;
  const w = Math.max(16, Math.round(width / 2) * 2);
  return { width: w, height: Math.max(16, Math.round(w / a / 2) * 2) };
}

/** GL rows run bottom-up; images run top-down. */
export function flipRows(src: ArrayLike<number>, width: number, height: number, dst = new Uint8ClampedArray(width * height * 4)): Uint8ClampedArray {
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    const to = y * row;
    for (let i = 0; i < row; i++) dst[to + i] = src[from + i];
  }
  return dst;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('could not read the image'));
    r.readAsDataURL(blob);
  });
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(w, h);
    } catch {
      /* fall through */
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToJpeg(canvas: AnyCanvas, quality: number): Promise<string> {
  if ('convertToBlob' in canvas) return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
  const blob = await new Promise<Blob | null>((r) => (canvas as HTMLCanvasElement).toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('the browser could not encode the snapshot');
  return blobToDataUrl(blob);
}

/** Encodes top-down RGBA pixels as a JPEG data URL. */
export async function encodeJpeg(rgba: Uint8ClampedArray, width: number, height: number, quality = DEFAULT_SNAPSHOT.quality): Promise<string> {
  const canvas = makeCanvas(width, height);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) throw new Error('no 2D canvas for the snapshot');
  g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvasToJpeg(canvas, quality);
}

export interface LoadedImage {
  image: string;
  /** Natural size of the source (EXIF orientation applied). */
  width: number;
  height: number;
}

/**
 * Fetches an image (a scene's input photo or video plate) and re-encodes it as a JPEG data URL at
 * most `maxWidth` wide. Normalised hotspot positions are the same in the original and the copy.
 */
export async function loadImageAsJpeg(url: string, maxWidth = 1024, quality = 0.85, signal?: AbortSignal): Promise<LoadedImage> {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(w, h);
    const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) throw new Error('no 2D canvas');
    g.drawImage(bitmap, 0, 0, w, h);
    return { image: await canvasToJpeg(canvas, quality), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

interface Pending {
  resolve: (s: Snapshot) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Takes snapshots on request. request() may be called from anywhere (a key handler, a network
 * callback); the drawing happens in the next tick(), which the guide calls from the frame loop.
 */
export class SnapshotTaker {
  readonly opts: SnapshotOptions;
  /** Milliseconds the last capture spent on the main thread inside the frame (render + read setup). */
  lastFrameCostMs = 0;
  /** Milliseconds from request to finished JPEG for the last snapshot. */
  lastTotalMs = 0;
  private rt: THREE.WebGLRenderTarget | null = null;
  private queue: Pending[] = [];
  private inFlight = false;
  private disposed = false;
  private requestedAt = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    /** Objects to hide while drawing (the guide's own labels and panels, controllers). */
    private hideDuring: () => THREE.Object3D[] = () => [],
    opts: Partial<SnapshotOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SNAPSHOT, ...opts };
  }

  get pending(): boolean {
    return this.queue.length > 0 || this.inFlight;
  }

  /** A snapshot of the current view, taken at the next frame. */
  request(): Promise<Snapshot> {
    if (this.disposed) return Promise.reject(new Error('snapshots are off'));
    if (!this.queue.length && !this.inFlight) this.requestedAt = performance.now();
    return new Promise<Snapshot>((resolve, reject) => {
      const p: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((q) => q !== p);
          reject(new Error('the snapshot took too long'));
        }, this.opts.timeoutMs),
      };
      this.queue.push(p);
    });
  }

  /** Call once per frame, before the main render. */
  tick(): void {
    if (this.disposed || this.inFlight || !this.queue.length) return;
    const waiting = this.queue;
    this.queue = [];
    this.inFlight = true;
    const settle = (fn: (p: Pending) => void) => {
      for (const p of waiting) {
        clearTimeout(p.timer);
        fn(p);
      }
    };
    let job: Promise<Snapshot>;
    try {
      job = this.capture();
    } catch (e) {
      job = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    job
      .then((s) => {
        this.lastTotalMs = performance.now() - this.requestedAt;
        settle((p) => p.resolve(s));
      })
      .catch((e: unknown) => settle((p) => p.reject(e instanceof Error ? e : new Error(String(e)))))
      .finally(() => {
        this.inFlight = false;
      });
  }

  /** A camera at the current head pose with the snapshot's own projection. */
  private monoCamera(width: number, height: number, xr: boolean): THREE.PerspectiveCamera {
    const src = this.camera;
    src.updateMatrixWorld(true);
    const fov = xr ? this.opts.xrFov : src.fov;
    const cam = new THREE.PerspectiveCamera(fov, width / height, Math.max(0.02, src.near), Math.max(50, src.far));
    src.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.scale.set(1, 1, 1);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
  }

  private target(width: number, height: number): THREE.WebGLRenderTarget {
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.SRGBColorSpace,
        samples: 0,
      });
      // shaders write sRGB like they do for the screen (see the header comment) ...
      (this.rt as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      // ... into plain RGBA8 storage: an SRGB8_ALPHA8 store would encode those values a second time
      this.rt.texture.internalFormat = 'RGBA8';
    } else if (this.rt.width !== width || this.rt.height !== height) {
      this.rt.setSize(width, height);
    }
    return this.rt;
  }

  private async capture(): Promise<Snapshot> {
    const t0 = performance.now();
    const r = this.renderer;
    const xr = r.xr.isPresenting;
    const size = xr
      ? snapshotSize(this.opts.xrAspect, this.opts.width, this.opts.xrAspect, this.opts.xrAspect)
      : snapshotSize(window.innerWidth / Math.max(1, window.innerHeight), this.opts.width, this.opts.minAspect, this.opts.maxAspect);
    const { width, height } = size;
    const cam = this.monoCamera(width, height, xr);
    const rt = this.target(width, height);

    const hidden: Array<[THREE.Object3D, boolean]> = [];
    const hide = (o: THREE.Object3D | null | undefined) => {
      if (o && o.visible) {
        hidden.push([o, true]);
        o.visible = false;
      }
    };
    for (const o of this.hideDuring()) hide(o);
    // the head veil (fades, vignette) rides on the user camera
    for (const c of this.camera.children) hide(c);

    const buf = new Uint8Array(width * height * 4);
    const xrEnabled = r.xr.enabled;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearAlpha();
    let read: Promise<unknown>;
    try {
      r.xr.enabled = false;
      r.setRenderTarget(rt);
      r.setClearAlpha(1);
      r.clear(true, true, false);
      r.render(this.scene, cam);
      // the readback starts here, synchronously; only the wait is async
      read = typeof r.readRenderTargetPixelsAsync === 'function'
        ? r.readRenderTargetPixelsAsync(rt, 0, 0, width, height, buf)
        : Promise.resolve(r.readRenderTargetPixels(rt, 0, 0, width, height, buf));
    } finally {
      r.setRenderTarget(prevTarget);
      r.xr.enabled = xrEnabled;
      r.setClearAlpha(prevClear);
      for (const [o, v] of hidden) o.visible = v;
    }
    this.lastFrameCostMs = performance.now() - t0;
    await read;
    const rgba = flipRows(buf, width, height);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const image = await encodeJpeg(rgba, width, height, this.opts.quality);
    return { image, width, height, camera: cam, takenAt: t0, xr };
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.queue) {
      clearTimeout(p.timer);
      p.reject(new Error('snapshots are off'));
    }
    this.queue = [];
    this.rt?.dispose();
    this.rt = null;
  }
}
