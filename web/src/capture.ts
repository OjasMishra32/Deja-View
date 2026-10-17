// Capture / upload flow, phone first: pick a mode, take or choose media, name it, upload with
// progress, land on the gallery with the new card highlighted.

import { createScene, getHealth, lanUrls, splitErrorMessage, type CreatableMode, type UploadFile, type UploadHandle } from './api.ts';
import { qrSvg } from './gallery.ts';

export type MediaKind = 'image' | 'video';

export interface SelectionSummary {
  images: number;
  videos: number;
  prompt: string;
}

/** Returns an error message, or null when the selection can be uploaded for this mode. */
export function validateSelection(mode: CreatableMode, sel: SelectionSummary): string | null {
  const { images, videos } = sel;
  const prompt = sel.prompt.trim();
  if (mode === 'thirdwheel') {
    if (images > 0) return 'Third Wheel takes one video, not photos. Photos go in Rent Free.';
    if (videos === 0) return 'Add one video: prop the phone up, hit record, cook.';
    if (videos > 1) return 'Just one video, please. Pick your favourite take.';
    return null;
  }
  if (mode === 'rentfree') {
    if (images > 0 && videos > 0) return 'Pick photos or a clip, not both.';
    if (videos > 1) return 'One clip at a time.';
    if (!images && !videos && !prompt) return 'Add a photo or a clip, or describe a room in the prompt.';
    return null;
  }
  if (images > 0 && videos > 0) return 'Pick photos or a video, not both.';
  if (videos > 1) return 'One video at a time.';
  if (!videos && images < 8) return `Reconstruct needs at least 8 photos (you have ${images}) or one video.`;
  return null;
}

export function kindOf(file: { type: string; name: string }): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  return null;
}

/** The message to keep on the page after a failed upload. */
export function uploadErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return msg.trim() || 'The upload failed without a reason. Try again.';
}

/** Size that fits inside max x max, never upscaling. */
export function fitWithin(width: number, height: number, max = 2048): [number, number] {
  const s = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))];
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------------------------
// Image downscaling: max 2048 px JPEG. createImageBitmap decodes HEIC where the browser can
// (Safari), applies EXIF orientation, and keeps the main thread free.

async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// EXIF carry-over. Re-encoding drops metadata, but the server reads the 35 mm focal length from
// EXIF for better camera intrinsics. Copy the original APP1 segment into the new JPEG, with the
// orientation reset to 1 because the pixels have already been rotated upright.

/** The APP1 "Exif" segment of a JPEG (marker and length included), or null. */
export function findExifSegment(buf: Uint8Array): Uint8Array | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (buf[o + 2] << 8) | buf[o + 3];
    if (len < 2) return null;
    const isExif = marker === 0xe1 && len >= 14 && buf[o + 4] === 0x45 && buf[o + 5] === 0x78 && buf[o + 6] === 0x69 && buf[o + 7] === 0x66 && buf[o + 8] === 0 && buf[o + 9] === 0;
    if (isExif) return o + 2 + len <= buf.length ? buf.slice(o, o + 2 + len) : null;
    o += 2 + len;
  }
  return null;
}

/** Sets the IFD0 orientation tag of a copied APP1 Exif segment to 1, in place. */
export function resetExifOrientation(seg: Uint8Array): Uint8Array {
  const t = 10; // FF E1, length, "Exif\0\0", then the TIFF header
  if (seg.length < t + 8) return seg;
  const le = seg[t] === 0x49;
  const u16 = (p: number) => (le ? seg[p] | (seg[p + 1] << 8) : (seg[p] << 8) | seg[p + 1]);
  const u32 = (p: number) => (le ? (seg[p] | (seg[p + 1] << 8) | (seg[p + 2] << 16) | (seg[p + 3] << 24)) >>> 0 : ((seg[p] << 24) | (seg[p + 1] << 16) | (seg[p + 2] << 8) | seg[p + 3]) >>> 0);
  const ifd = t + u32(t + 4);
  if (ifd + 2 > seg.length) return seg;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.length) break;
    if (u16(e) === 0x0112) {
      seg[e + 8] = le ? 1 : 0;
      seg[e + 9] = le ? 0 : 1;
    }
  }
  return seg;
}

/** Inserts an APP1 segment right after the SOI marker of an encoded JPEG. */
export function insertApp1(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

async function carryExif(original: Blob, encoded: Blob): Promise<Blob> {
  try {
    const head = new Uint8Array(await original.slice(0, 256 * 1024).arrayBuffer());
    const seg = findExifSegment(head);
    if (!seg) return encoded;
    const out = insertApp1(new Uint8Array(await encoded.arrayBuffer()), resetExifOrientation(seg));
    return new Blob([out as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  } catch {
    return encoded;
  }
}

export async function downscaleToJpeg(file: Blob, max = 2048, quality = 0.9): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await decodeImage(file);
  try {
    const [w, h] = fitWithin(img.width, img.height, max);
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img.source, 0, 0, w, h);
        return { blob: await carryExif(file, await c.convertToBlob({ type: 'image/jpeg', quality })), width: w, height: h };
      }
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('JPEG encode failed');
    return { blob: await carryExif(file, blob), width: w, height: h };
  } finally {
    img.close();
  }
}

function videoInfo(file: Blob): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (info: { duration: number; width: number; height: number }) => {
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve(info);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => done({ duration: NaN, width: 0, height: 0 });
    setTimeout(() => done({ duration: NaN, width: 0, height: 0 }), 8000);
    v.src = url;
  });
}

// ---------------------------------------------------------------------------------------------
// Page

interface Item {
  id: number;
  kind: MediaKind;
  file: File;
  blob?: Blob; // processed upload (images)
  url: string; // preview
  width?: number;
  height?: number;
  duration?: number;
  status: 'processing' | 'ready' | 'raw';
  note?: string;
}

const COPY: Record<CreatableMode, {
  eyebrow: string;
  title: string;
  lede: string;
  media: string;
  camera: [string, string, string];
  files: [string, string, string];
  name: string;
  promptLabel: string;
  promptHint: string;
  submit: string;
  sideTitle: string;
  tips: [string, string][];
  note: string;
}> = {
  rentfree: {
    eyebrow: 'New world · Rent Free',
    title: 'Snap it. Move in.',
    lede: 'One photo of a room, a calm game clip, or just a description. We build the rest of the room around it.',
    media: 'Add your shot',
    camera: ['Take a photo', 'Opens the camera on a phone', 'image/*'],
    files: ['Choose photos or a clip', 'Or drop files here', 'image/*,video/*'],
    name: 'Room, rent free',
    promptLabel: 'Prompt',
    promptHint: 'optional, or use it instead of a photo',
    submit: 'Build my world',
    sideTitle: 'One wide photo from a corner.',
    tips: [
      ['Back into a corner and shoot wide.', 'Floor and ceiling in the frame.'],
      ['Lights on, no zoom, landscape.', 'Hold still for a beat before you tap.'],
      ['Game clips: calm camera.', 'Slow pans, no menus, no motion blur. We pick the sharpest frame.'],
    ],
    note: 'What happens next: a world model builds the whole room around your shot, including what is behind you. Seconds on the warm GPU worker, a few minutes on a fallback.',
  },
  thirdwheel: {
    eyebrow: 'New world · Third Wheel',
    title: 'Roll camera. Be the third wheel.',
    lede: 'One video of someone doing something: cooking, juggling, explaining their sourdough starter. You get to stand in the room with them.',
    media: 'Add one video',
    camera: ['Record a video', 'Opens the camera on a phone', 'video/*'],
    files: ['Choose a video', 'Or drop it here', 'video/*'],
    name: 'Cooking, plus one',
    promptLabel: 'Describe the room',
    promptHint: 'optional, helps fill in what the camera missed',
    submit: 'Third-wheel it',
    sideTitle: 'Prop the phone. Do not hold it.',
    tips: [
      ['Prop the phone on something solid.', 'The room is built from whatever stays still.'],
      ['Whole person in frame, 1 to 3 m away.', 'Feet included, please.'],
      ['10 to 30 seconds, good light.', 'Nobody walking through the shot.'],
    ],
    note: 'What happens next: per-frame depth, a cut-out of your friend, an empty-room plate, then a generated room around it. Sound stays. A minute or two on the GPU.',
  },
  reconstruct: {
    eyebrow: 'New world · Reconstruct',
    title: 'Every angle. Exactly.',
    lede: 'Lots of overlapping photos become a faithful copy of exactly what you shot. Nothing invented.',
    media: 'Add 8 or more photos, or a video',
    camera: ['Take a photo', 'Repeat as you walk around', 'image/*'],
    files: ['Choose photos or a video', 'Or drop them here', 'image/*,video/*'],
    name: 'Exact copy',
    promptLabel: 'Notes',
    promptHint: 'optional',
    submit: 'Reconstruct it',
    sideTitle: 'Walk a slow loop.',
    tips: [
      ['8 to 40 photos, overlapping by half.', 'Step sideways between shots, do not just turn.'],
      ['Same exposure throughout.', 'No zoom, no portrait mode.'],
      ['A slow walking video works too.', 'We sample frames from it.'],
    ],
    note: 'What happens next: cameras are estimated and a splat is fitted to your photos. Takes a few minutes on the GPU.',
  },
};

const ICON_PHOTO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function main() {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = $<HTMLFormElement>('capture-form');
  const nameInput = $<HTMLInputElement>('scene-name');
  const promptInput = $<HTMLTextAreaElement>('scene-prompt');
  const camInput = $<HTMLInputElement>('pick-camera');
  const filesInput = $<HTMLInputElement>('pick-files');
  const previews = $('previews');
  const errorEl = $('capture-error');
  const submit = $<HTMLButtonElement>('submit');
  const cancel = $<HTMLButtonElement>('cancel');
  const upload = $('upload');
  const dropzone = $('dropzone');

  const params = new URLSearchParams(location.search);
  let mode: CreatableMode = (['rentfree', 'thirdwheel', 'reconstruct'] as const).includes(params.get('mode') as CreatableMode)
    ? (params.get('mode') as CreatableMode)
    : 'rentfree';
  let items: Item[] = [];
  let nextId = 1;
  let nameTouched = false;
  let busy: UploadHandle | null = null;
  let triedSubmit = false;
  // Messages that outlive revalidate(): the server's answer to the last upload, and notes about
  // the last pick (skipped files, a long clip). Both clear when the selection or mode changes.
  let uploadError: string | null = null;
  let pickNotes: string[] = [];

  const summary = (): SelectionSummary => ({
    images: items.filter((i) => i.kind === 'image').length,
    videos: items.filter((i) => i.kind === 'video').length,
    prompt: promptInput.value,
  });

  /** Shows a message; server errors keep their tool output in a collapsed details block. */
  function showError(msg: string | null) {
    if (errorEl.dataset.msg === (msg ?? '')) return; // keep an opened details block open
    errorEl.dataset.msg = msg ?? '';
    const { headline, detail } = splitErrorMessage(msg);
    errorEl.replaceChildren();
    if (!headline) return;
    const line = document.createElement('span');
    line.className = 'form-error-text';
    line.textContent = headline;
    errorEl.append(line);
    if (detail) {
      const more = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'Details';
      const pre = document.createElement('pre');
      pre.textContent = detail;
      more.append(sum, pre);
      errorEl.append(more);
    }
  }

  /** The selection changed: earlier server answers and pick notes no longer apply. */
  function selectionChanged() {
    uploadError = null;
    pickNotes = [];
  }

  function revalidate() {
    // Do not nag before the first attempt, except for picks that can never work in this mode.
    const sel = summary();
    const err = validateSelection(mode, sel);
    const hardWrong = mode === 'thirdwheel' && (sel.images > 0 || sel.videos > 1);
    const validation = triedSubmit || hardWrong ? err : null;
    showError(validation ?? uploadError ?? (pickNotes.length ? pickNotes.join(' ') : null));
    submit.disabled = !!busy || items.some((i) => i.status === 'processing');
  }

  function applyMode(next: CreatableMode) {
    if (next !== mode) selectionChanged();
    mode = next;
    const c = COPY[mode];
    for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-opt')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    $('cap-eyebrow').textContent = c.eyebrow;
    $('cap-title').textContent = c.title;
    $('cap-lede').textContent = c.lede;
    $('media-label').textContent = c.media;
    $('pick-camera-text').textContent = c.camera[0];
    $('pick-camera-hint').textContent = c.camera[1];
    camInput.accept = c.camera[2];
    $('pick-files-text').textContent = c.files[0];
    $('pick-files-hint').textContent = c.files[1];
    filesInput.accept = c.files[2];
    filesInput.multiple = mode !== 'thirdwheel';
    $('prompt-label').innerHTML = `${esc(c.promptLabel)} <small>${esc(c.promptHint)}</small>`;
    nameInput.placeholder = c.name;
    if (!nameTouched) nameInput.value = c.name;
    submit.innerHTML = `${esc(c.submit)} <span class="arrow">&rarr;</span>`;
    $('side-title').textContent = c.sideTitle;
    $('side-tips').innerHTML = c.tips
      .map(([b, t], i) => `<li><span>${String(i + 1).padStart(2, '0')}</span><span><b>${esc(b)}</b> ${esc(t)}</span></li>`)
      .join('');
    $('side-note').textContent = c.note;
    const url = new URL(location.href);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url.pathname + url.search);
    revalidate();
  }

  function renderPreviews() {
    previews.innerHTML = items
      .map((it) => {
        const meta =
          it.kind === 'video'
            ? `${Number.isFinite(it.duration) ? `${it.duration!.toFixed(1)} s · ` : ''}${it.width ? `${it.width}×${it.height} · ` : ''}${(it.file.size / 1024 / 1024).toFixed(1)} MB`
            : it.status === 'processing'
              ? 'shrinking…'
              : it.width
                ? `${it.width}×${it.height} · ${formatBytes(it.blob?.size ?? it.file.size)}`
                : it.note ?? formatBytes(it.file.size);
        // A photo this browser could not decode (status 'raw') would only show a broken-image icon.
        const media =
          it.kind === 'video'
            ? `<video src="${esc(it.url)}#t=0.1" muted playsinline preload="metadata"></video>`
            : it.status === 'raw'
              ? `<div class="pv-ph" aria-hidden="true">${ICON_PHOTO}</div>`
              : `<img src="${esc(it.url)}" alt="">`;
        return `<div class="pv${it.kind === 'video' ? ' wide' : ''}" data-id="${it.id}">${media}<span class="pv-meta">${esc(meta)}</span><button type="button" class="pv-x" aria-label="Remove">&times;</button></div>`;
      })
      .join('');
  }

  async function addFiles(list: FileList | File[]) {
    const files = [...list];
    if (!files.length) return;
    selectionChanged();
    const fresh: Item[] = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) {
        pickNotes.push(`${file.name}: not a photo or a video, skipped.`);
        continue;
      }
      // Third Wheel holds exactly one video: a new pick replaces the old one.
      if (mode === 'thirdwheel' && kind === 'video') {
        for (const old of items.filter((i) => i.kind === 'video')) URL.revokeObjectURL(old.url);
        items = items.filter((i) => i.kind !== 'video');
      }
      const it: Item = { id: nextId++, kind, file, url: URL.createObjectURL(file), status: kind === 'image' ? 'processing' : 'ready' };
      items.push(it);
      fresh.push(it);
    }
    renderPreviews();
    revalidate();
    await Promise.all(
      fresh.map(async (it) => {
        if (it.kind === 'video') {
          const info = await videoInfo(it.file);
          Object.assign(it, info);
          if (mode === 'thirdwheel' && info.duration > 60 && items.includes(it)) pickNotes.push('Long clip. Anything past 30 s just takes longer to process.');
          return;
        }
        try {
          const out = await downscaleToJpeg(it.file);
          URL.revokeObjectURL(it.url);
          it.blob = out.blob;
          it.width = out.width;
          it.height = out.height;
          it.url = URL.createObjectURL(out.blob);
          it.status = 'ready';
        } catch {
          // The server can still try (for example HEIC on a browser that cannot decode it).
          it.status = 'raw';
          it.note = 'sent as is';
        }
      }),
    );
    renderPreviews();
    revalidate();
  }

  function setProgress(fraction: number, loaded: number, total: number, startedAt: number) {
    const pct = Number.isFinite(fraction) ? Math.round(fraction * 100) : null;
    $('up-pct').textContent = pct !== null ? `${pct}%` : '';
    $('up-fill').style.transform = `scaleX(${pct !== null ? Math.max(0.01, fraction) : 0.3})`;
    $('up-bytes').textContent = total ? `${formatBytes(loaded)} of ${formatBytes(total)}` : formatBytes(loaded);
    const secs = (performance.now() - startedAt) / 1000;
    $('up-speed').textContent = secs > 0.5 && loaded ? `${formatBytes(loaded / secs)}/s` : '';
    if (pct === 100) $('up-stage').textContent = 'Handing it to the GPU…';
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (busy) return;
    triedSubmit = true;
    const err = validateSelection(mode, summary());
    const name = nameInput.value.trim() || COPY[mode].name;
    if (err) {
      showError(err);
      return;
    }
    if (items.some((i) => i.status === 'processing')) {
      showError('Still shrinking your photos, one second.');
      return;
    }
    uploadError = null;
    showError(null);
    const files: UploadFile[] = items.map((it, i) =>
      it.kind === 'image' && it.blob
        ? { blob: it.blob, name: `${String(i).padStart(2, '0')}.jpg` }
        : { blob: it.file, name: it.file.name || (it.kind === 'video' ? 'video.mp4' : `${i}.jpg`) },
    );
    const startedAt = performance.now();
    upload.classList.add('show');
    $('up-stage').textContent = files.length ? 'Uploading' : 'Sending the prompt';
    setProgress(0, 0, files.reduce((a, f) => a + f.blob.size, 0), startedAt);
    submit.disabled = true;
    cancel.hidden = false;
    busy = createScene({ mode, name, prompt: promptInput.value, files }, (p) => setProgress(p.fraction, p.loaded, p.total, startedAt));
    try {
      const scene = await busy.promise;
      $('up-stage').textContent = 'Uploaded. Off it goes.';
      location.href = `/?new=${encodeURIComponent(scene.id)}#gallery`;
    } catch (error) {
      // Stored, not just shown: revalidate() would otherwise clear it straight away.
      uploadError = uploadErrorMessage(error);
      upload.classList.remove('show');
      busy = null;
      cancel.hidden = true;
      revalidate();
      errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Wire up
  for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-opt')) {
    b.addEventListener('click', () => applyMode(b.dataset.mode as CreatableMode));
    b.addEventListener('keydown', (e) => {
      const order: CreatableMode[] = ['rentfree', 'thirdwheel', 'reconstruct'];
      const i = order.indexOf(mode);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') applyMode(order[(i + 1) % 3]);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') applyMode(order[(i + 2) % 3]);
      else return;
      e.preventDefault();
      document.querySelector<HTMLButtonElement>(`.mode-opt[data-mode="${mode}"]`)?.focus();
    });
  }
  for (const input of [camInput, filesInput]) {
    input.addEventListener('change', () => {
      if (input.files) void addFiles(input.files);
      input.value = '';
    });
  }
  previews.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).closest('.pv-x');
    if (!x) return;
    const id = Number(x.closest<HTMLElement>('.pv')?.dataset.id);
    const it = items.find((i) => i.id === id);
    if (it) URL.revokeObjectURL(it.url);
    items = items.filter((i) => i.id !== id);
    selectionChanged();
    renderPreviews();
    revalidate();
  });
  nameInput.addEventListener('input', () => (nameTouched = true));
  promptInput.addEventListener('input', revalidate);
  form.addEventListener('submit', onSubmit);
  cancel.addEventListener('click', () => busy?.abort());

  // Desktop drag and drop.
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    dropzone.classList.add('drag');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dropzone.classList.remove('drag');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dropzone.classList.remove('drag');
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  });

  // Leaving mid-upload loses it.
  window.addEventListener('beforeunload', (e) => {
    if (busy && !upload.textContent?.includes('Off it goes')) e.preventDefault();
  });

  applyMode(mode);

  // On a laptop, offer the phone link.
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) {
    getHealth()
      .then((h) => {
        const url = lanUrls(h)[0] ?? (/^(localhost|127\.)/.test(location.hostname) ? null : location.origin);
        if (!url) return;
        const full = `${url}/capture?mode=${mode}`;
        $('phone-hint').hidden = false;
        const link = $<HTMLAnchorElement>('lan-url');
        // Break before "/capture" rather than mid-word when the side card is narrow.
        link.replaceChildren(url.replace(/^https?:\/\//, ''), document.createElement('wbr'), '/capture');
        link.href = full;
        try {
          $('qr').innerHTML = qrSvg(`${url}/capture`);
        } catch {}
      })
      .catch(() => {});
  }
}

if (typeof document !== 'undefined' && document.getElementById('capture-form')) main();
