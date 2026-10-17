// Text, shapes and icons for the headset panels. Each panel is drawn into a canvas at 2x, uploaded
// once as a mipmapped, premultiplied texture and drawn again only when what it shows changes
// (never per frame). Sizes are in design pixels; a panel maps them to metres.

import * as THREE from 'three';

export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", Roboto, system-ui, sans-serif';
export const FONT_DISPLAY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", Roboto, system-ui, sans-serif';

/** The glass: smoky translucent material, white text, quiet fills (visionOS window colours, without the blur). */
export const GLASS = {
  top: 'rgba(70,72,80,0.90)',
  bottom: 'rgba(42,44,50,0.94)',
  rim: 'rgba(255,255,255,0.16)',
  sheen: 'rgba(255,255,255,0.07)',
  shadow: 'rgba(0,0,0,0.30)',
  text: '#ffffff',
  secondary: 'rgba(235,235,245,0.66)',
  tertiary: 'rgba(235,235,245,0.42)',
  fill: 'rgba(255,255,255,0.09)',
  fillHover: 'rgba(255,255,255,0.20)',
  /** Under a lifted item, so the panel's own copy of it does not show through. */
  plate: 'rgba(64,66,74,0.98)',
  on: 'rgba(255,255,255,0.95)',
  onText: '#1c1c1e',
  onSecondary: 'rgba(60,60,67,0.72)',
  red: '#ff6961',
} as const;

/** A canvas and its texture. begin() clears it and scales to design pixels; commit() uploads it once. */
export class CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;

  constructor(readonly width: number, readonly height: number, readonly scale = 2) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(width * scale);
    this.canvas.height = Math.ceil(height * scale);
    this.g = this.canvas.getContext('2d')!;
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    // premultiplied, so mipmaps of soft edges and shadows do not pick up dark fringes
    t.premultiplyAlpha = true;
    t.anisotropy = 4;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    this.texture = t;
  }

  begin(): CanvasRenderingContext2D {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    g.globalAlpha = 1;
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    tracking(g, 0);
    return g;
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }

  /** Shows only the top-left `w` x `h` design pixels of the canvas (the rest stays transparent). */
  crop(w: number, h: number): void {
    const fx = Math.min(1, w / this.width), fy = Math.min(1, h / this.height);
    this.texture.repeat.set(fx, fy);
    this.texture.offset.set(0, 1 - fy);
  }

  dispose(): void {
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}

/**
 * Material for a premultiplied canvas texture. setGlassOpacity() fades it (colour and alpha together,
 * as premultiplied blending needs).
 */
export function glassMaterial(map: THREE.Texture | null, depthTest: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthTest,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

export function setGlassOpacity(m: THREE.MeshBasicMaterial, o: number): void {
  if (m.opacity === o) return;
  m.opacity = o;
  // the texture is decoded from sRGB, so the colour scale is too: the output then fades linearly
  m.color.setRGB(o, o, o, THREE.SRGBColorSpace);
}

export function font(g: CanvasRenderingContext2D, weight: number, size: number, display = false): void {
  g.font = `${weight} ${size}px ${display ? FONT_DISPLAY : FONT}`;
}

/** Letter spacing in pixels, where the canvas supports it. */
export function tracking(g: CanvasRenderingContext2D, px: number): void {
  const c = g as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Measures with whatever font is set (tests pass their own). */
export type Measure = (text: string) => number;

/** `text`, cut at the end with an ellipsis so it fits `maxW`. */
export function ellipsize(text: string, maxW: number, measure: Measure): string {
  if (measure(text) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '…';
}

/** Greedy word wrap into at most `maxLines`; the last line ends in an ellipsis when text is left over. */
export function wrapText(text: string, maxW: number, maxLines: number, measure: Measure): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next) <= maxW || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    line = '';
    i = words.length;
  }
  if (i < words.length || line) {
    const rest = [lines.pop() ?? '', ...words.slice(i)].join(' ');
    lines.push(ellipsize(rest, maxW, measure));
  }
  return lines.map((l) => (measure(l) > maxW ? ellipsize(l, maxW, measure) : l));
}

/**
 * A caption short enough for one line: the leading repeat of the world's name goes ("The Lawn, rebuilt from 25
 * photos: ..." becomes "Rebuilt from 25 photos") and only the first clause stays.
 */
export function shortCaption(name: string, caption: string | null | undefined): string {
  let c = (caption ?? '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  const n = name.replace(/\s+/g, ' ').trim().toLowerCase();
  const lower = c.toLowerCase();
  for (const lead of n ? [`the ${n}`, n] : []) {
    if (!lower.startsWith(lead)) continue;
    const rest = c.slice(lead.length).replace(/^[\s,:;.–—-]+/, '');
    if (rest) c = rest[0].toUpperCase() + rest.slice(1);
    break;
  }
  const cut = c.search(/[:;]|\.(\s|$)/);
  if (cut >= 12) c = c.slice(0, cut);
  return c.trim();
}

/** The glass sheet itself: soft shadow, top-lit fill, a hairline rim and a faint sheen on the upper edge. */
export function drawGlass(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, shadow = 18): void {
  g.save();
  if (shadow > 0) {
    roundRect(g, x, y, w, h, r);
    g.shadowColor = GLASS.shadow;
    g.shadowBlur = shadow;
    g.shadowOffsetY = shadow * 0.3;
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fill();
    g.shadowColor = 'transparent';
    // the shadow's own fill is cleared away, so the glass stays translucent
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  roundRect(g, x, y, w, h, r);
  const fill = g.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, GLASS.top);
  fill.addColorStop(1, GLASS.bottom);
  g.fillStyle = fill;
  g.fill();
  const sheen = g.createLinearGradient(0, y, 0, y + Math.min(h, 90));
  sheen.addColorStop(0, GLASS.sheen);
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fill();
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
  const rim = g.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, GLASS.rim);
  rim.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  rim.addColorStop(1, 'rgba(255,255,255,0.08)');
  g.strokeStyle = rim;
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

export type IconName = 'recenter' | 'labels' | 'people' | 'ask' | 'exit' | 'play' | 'pause' | 'check' | 'photo' | 'video';

/** Line icons in a box of `s` pixels centred on (cx, cy), stroked or filled in `color`. */
export function drawIcon(g: CanvasRenderingContext2D, name: IconName, cx: number, cy: number, s: number, color: string): void {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = Math.max(1.25, s * 0.085);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const u = s / 2;
  g.beginPath();
  switch (name) {
    case 'recenter': {
      // a viewfinder with a dot in the middle
      const a = u * 0.82, c = u * 0.42;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        g.moveTo(cx + sx * a, cy + sy * (a - c));
        g.lineTo(cx + sx * a, cy + sy * a);
        g.lineTo(cx + sx * (a - c), cy + sy * a);
      }
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, u * 0.2, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'labels': {
      // a tag
      const l = cx - u * 0.86, m = cx - u * 0.3, r = cx + u * 0.84, t = cy - u * 0.58, b = cy + u * 0.58;
      g.moveTo(l, cy);
      g.lineTo(m, t);
      g.lineTo(r - 3, t);
      g.quadraticCurveTo(r, t, r, t + 3);
      g.lineTo(r, b - 3);
      g.quadraticCurveTo(r, b, r - 3, b);
      g.lineTo(m, b);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.arc(m + u * 0.06, cy, u * 0.13, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'people': {
      // two people, one behind the other
      g.arc(cx + u * 0.38, cy - u * 0.36, u * 0.26, 0, Math.PI * 2);
      g.moveTo(cx + u * 0.02, cy + u * 0.02);
      g.arc(cx + u * 0.38, cy + u * 0.58, u * 0.5, Math.PI * 1.25, Math.PI * 1.98);
      g.stroke();
      g.beginPath();
      g.arc(cx - u * 0.26, cy - u * 0.26, u * 0.32, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(cx - u * 0.26, cy + u * 0.82, u * 0.66, Math.PI * 1.08, Math.PI * 1.92);
      g.stroke();
      break;
    }
    case 'ask': {
      // a voice waveform
      const hs = [0.34, 0.7, 1, 0.62, 0.3];
      hs.forEach((h, i) => {
        const x = cx + (i - 2) * u * 0.4;
        g.moveTo(x, cy - h * u * 0.8);
        g.lineTo(x, cy + h * u * 0.8);
      });
      g.stroke();
      break;
    }
    case 'exit': {
      // a door frame with an arrow leaving it
      const l = cx - u * 0.82, r = cx + u * 0.1, t = cy - u * 0.8, b = cy + u * 0.8;
      g.moveTo(r, cy - u * 0.38);
      g.lineTo(r, t + 3);
      g.quadraticCurveTo(r, t, r - 3, t);
      g.lineTo(l + 3, t);
      g.quadraticCurveTo(l, t, l, t + 3);
      g.lineTo(l, b - 3);
      g.quadraticCurveTo(l, b, l + 3, b);
      g.lineTo(r - 3, b);
      g.quadraticCurveTo(r, b, r, b - 3);
      g.lineTo(r, cy + u * 0.38);
      g.moveTo(cx - u * 0.32, cy);
      g.lineTo(cx + u * 0.9, cy);
      g.moveTo(cx + u * 0.56, cy - u * 0.34);
      g.lineTo(cx + u * 0.9, cy);
      g.lineTo(cx + u * 0.56, cy + u * 0.34);
      g.stroke();
      break;
    }
    case 'play': {
      const l = cx - u * 0.52, r = cx + u * 0.78, t = cy - u * 0.82, b = cy + u * 0.82;
      g.lineWidth = s * 0.14;
      g.moveTo(l, t);
      g.lineTo(r, cy);
      g.lineTo(l, b);
      g.closePath();
      g.stroke();
      g.fill();
      break;
    }
    case 'pause': {
      const w = u * 0.5, h = u * 1.6;
      roundRect(g, cx - u * 0.7, cy - h / 2, w, h, w * 0.3);
      g.fill();
      roundRect(g, cx + u * 0.2, cy - h / 2, w, h, w * 0.3);
      g.fill();
      break;
    }
    case 'check': {
      g.lineWidth = Math.max(1.5, s * 0.13);
      g.moveTo(cx - u * 0.55, cy + u * 0.02);
      g.lineTo(cx - u * 0.15, cy + u * 0.42);
      g.lineTo(cx + u * 0.6, cy - u * 0.42);
      g.stroke();
      break;
    }
    case 'photo': {
      roundRect(g, cx - u * 0.85, cy - u * 0.62, u * 1.7, u * 1.24, u * 0.22);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - u * 0.6, cy + u * 0.4);
      g.lineTo(cx - u * 0.15, cy - u * 0.08);
      g.lineTo(cx + u * 0.15, cy + u * 0.2);
      g.lineTo(cx + u * 0.35, cy);
      g.lineTo(cx + u * 0.62, cy + u * 0.4);
      g.stroke();
      break;
    }
    case 'video': {
      roundRect(g, cx - u * 0.88, cy - u * 0.55, u * 1.2, u * 1.1, u * 0.22);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + u * 0.42, cy - u * 0.14);
      g.lineTo(cx + u * 0.88, cy - u * 0.42);
      g.lineTo(cx + u * 0.88, cy + u * 0.42);
      g.lineTo(cx + u * 0.42, cy + u * 0.14);
      g.closePath();
      g.stroke();
      break;
    }
  }
  g.restore();
}
