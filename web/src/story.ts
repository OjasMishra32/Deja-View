// The landing page's chapters after the intro (hero.ts, whose lens opens onto the walk through the
// project): how to make your own (drop in photos or a video) and where you can walk it.
//
// Drop in is a short pinned section. Its words and its card fade up together as they reach the screen, a
// short fade that runs on its own clock, so they are whole long before the stage pins and never left half
// faded when the scrolling stops. The 25 Game Lawn photos are dragged over the card as it settles; pinned,
// they fan out, upload, and the card turns into the world they made, with a real way in. It lets go
// straight after, and nothing fades out. Walk it anywhere is an ordinary section whose tiles rise in as
// each comes up the screen.
//
// Arriving by a link (#how, #anywhere) shows the words at once. Reduced motion: every chapter shows its
// finished state.

import { reducedMotion, sectionProgress, smooth } from './hero.ts';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** The words fade up once the section's top is this far up from the bottom of the screen (of the way to the bar). */
const SHOW_AT = 0.1;

// ---------------------------------------------------------------------------------------------
// A chapter: its section and how far it has come in, drawn only while it is near the screen.

abstract class Chapter {
  protected readonly stage: HTMLElement;
  protected visible = false;
  private raf = 0;
  protected readonly reduced = reducedMotion();

  constructor(protected readonly section: HTMLElement, protected readonly navH: number) {
    this.stage = section.querySelector<HTMLElement>('.chapter-stage') ?? section;
    new IntersectionObserver(
      (entries) => {
        const was = this.visible;
        this.visible = entries.some((e) => e.isIntersecting);
        if (this.visible && !was) this.wake();
        this.kick();
      },
      { rootMargin: '25% 0px' },
    ).observe(section);
    addEventListener('scroll', () => this.kick(), { passive: true });
    addEventListener('resize', () => this.kick());
    addEventListener('hashchange', () => {
      if (location.hash === `#${section.id}`) this.arrive();
    });
  }

  /** Call once the subclass is built: hides what has not come in yet, or shows it at once if it is already on screen. */
  protected start(): void {
    this.stage.classList.add('is-live');
    if (this.reduced || location.hash === `#${this.section.id}` || this.enter() > SHOW_AT) this.arrive();
  }

  /** 0 as the section's top comes up over the bottom of the screen, 1 when it reaches the bar (where a stage pins). */
  protected enter(): number {
    const top = this.section.getBoundingClientRect().top;
    return this.reduced ? 1 : clamp01((innerHeight - top) / Math.max(1, innerHeight - this.navH));
  }

  /** Everything shows at once, with nothing left part way through its fade (a link landing here, reduced motion). */
  protected arrive(): void {
    this.section.classList.add('no-anim');
    this.stage.classList.add('is-in');
    this.showAll();
    void this.section.offsetHeight; // apply it before the transitions come back
    requestAnimationFrame(() => requestAnimationFrame(() => this.section.classList.remove('no-anim')));
    this.kick();
  }
  protected showAll(): void {}

  /** First time the chapter comes near the screen: its pictures start loading. */
  protected wake(): void {
    for (const img of this.section.querySelectorAll<HTMLImageElement>('img[data-src]')) {
      if (img.getAttribute('src')) continue;
      img.addEventListener('error', () => this.missing(img), { once: true });
      img.src = img.dataset.src!;
    }
  }
  /** A picture that would not load. */
  protected missing(img: HTMLImageElement): void {
    img.remove();
  }
  /** Draws the chapter at `enter` (see enter()) and `p`, how far through its pin it is (0..1). */
  protected abstract draw(enter: number, p: number): void;

  protected kick(): void {
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    if (!this.visible) return;
    const enter = this.enter();
    const p = this.reduced ? 1 : sectionProgress(this.section, this.stage, this.navH);
    this.stage.style.setProperty('--p', p.toFixed(3));
    // the words come in once, when they reach the screen, and stay (a link's smooth scroll can pass below
    // the section first, and must not undo what arrive() showed)
    if (enter > SHOW_AT) this.stage.classList.add('is-in');
    this.draw(enter, p);
  }
}

// ---------------------------------------------------------------------------------------------
// Drop in a photo or a video: the photos go in as a stack, upload, and the card becomes the Game Lawn (DOM only)

class UploadChapter extends Chapter {
  private readonly card = this.section.querySelector<HTMLElement>('[data-upload-card]');
  private readonly status = this.section.querySelector<HTMLElement>('[data-upload-status]');
  private readonly ready = this.section.querySelector<HTMLElement>('[data-upload-ready]');
  private readonly walk = this.ready?.querySelector<HTMLAnchorElement>('a') ?? null;
  private state = '';

  constructor(section: HTMLElement, navH: number) {
    super(section, navH);
    this.start();
  }

  protected override missing(img: HTMLImageElement): void {
    // without the world's picture the card still ends on Ready, over the photos
    if (img.classList.contains('upload-world')) this.card?.classList.add('no-world');
    img.remove();
  }

  protected draw(enter: number, p: number): void {
    // one timeline in lengths of the pin: below 0 while the section is still coming up (the photos are
    // dragged over the card as it settles), 0..1 while it is pinned
    const range = Math.max(1, this.section.offsetHeight - this.stage.offsetHeight);
    const q = p > 0 ? p : ((enter - 1) * (innerHeight - this.navH)) / range;
    const drop = smooth(-0.42, -0.06, q); // dragged in as one stack, landed by the time it pins
    const fan = smooth(-0.04, 0.12, q); // lands and fans out
    const up = smooth(0.12, 0.48, q);
    const ready = smooth(0.64, 0.78, q); // building from 0.48, then the world, held until it lets go
    const s = this.stage.style;
    s.setProperty('--drop', drop.toFixed(3));
    s.setProperty('--fan', fan.toFixed(3));
    s.setProperty('--upload', up.toFixed(3));
    s.setProperty('--ready', ready.toFixed(3));

    const state = fan < 0.5 ? 'drop' : up < 1 ? 'upload' : ready < 0.5 ? 'building' : 'ready';
    const text =
      state === 'drop' ? 'Drop photos here' : state === 'upload' ? `Uploading · ${Math.round(up * 100)}%` : state === 'building' ? 'Building your world' : 'Ready';
    if (this.status && this.status.textContent !== text) this.status.textContent = text;
    if (state === this.state) return;
    this.state = state;
    this.card?.classList.toggle('is-building', state === 'building');
    this.card?.classList.toggle('is-ready', state === 'ready');
    // the way in is only there, for a pointer or a keyboard, once the world is
    this.ready?.setAttribute('aria-hidden', String(state !== 'ready'));
    if (this.walk) this.walk.tabIndex = state === 'ready' ? 0 : -1;
  }
}

// ---------------------------------------------------------------------------------------------
// Walk it anywhere: three tiles, each a real screenshot of the same world, rise in as they come up (DOM only)

class AnywhereChapter extends Chapter {
  private readonly rising = [...this.section.querySelectorAll<HTMLElement>('.anywhere-tile, .anywhere-cta')];

  constructor(section: HTMLElement, navH: number) {
    super(section, navH);
    this.start();
    if (!this.reduced) this.draw();
  }

  /** A screenshot that is missing takes its frame with it. */
  protected override missing(img: HTMLImageElement): void {
    const shot = img.closest('.anywhere-shot');
    if (shot) shot.remove();
    else img.remove();
  }

  protected override showAll(): void {
    for (const el of this.rising) el.classList.add('is-in');
  }

  protected draw(): void {
    const vh = innerHeight;
    const stageTop = this.stage.getBoundingClientRect().top;
    for (const el of this.rising) {
      // where it sits without its own rise (offsetTop ignores transforms; the stage is its offset parent)
      const top = stageTop + offsetWithin(el, this.stage);
      if (top < vh * 0.9) el.classList.add('is-in');
    }
  }
}

function offsetWithin(el: HTMLElement, root: HTMLElement): number {
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}

/** Starts every chapter on the page. */
export function startStory(): void {
  const navH = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 48;
  const make: Record<string, (s: HTMLElement) => Chapter> = {
    upload: (s) => new UploadChapter(s, navH),
    anywhere: (s) => new AnywhereChapter(s, navH),
  };
  for (const s of document.querySelectorAll<HTMLElement>('[data-chapter]')) make[s.dataset.chapter ?? '']?.(s);
}
