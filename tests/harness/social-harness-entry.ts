// Harness entry: boots the real viewer (app.ts), which builds the social layer and the guide itself once the world
// is visible. This only waits for that and raises window.__socialReady for tests/harness/social-shots.ts.

import '../../web/src/viewer/app.ts';
import type { SocialHandle } from '../../web/src/viewer/social/index.ts';

const w = window as unknown as {
  __viewer?: { ready: boolean; error: string | null };
  __viewerApp?: { social: SocialHandle | null };
  __social?: SocialHandle;
  __socialReady?: boolean;
};

async function main(): Promise<void> {
  for (;;) {
    if (w.__viewer?.error) return;
    if (w.__viewer?.ready && w.__viewerApp?.social) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  w.__social = w.__viewerApp!.social!;
  w.__socialReady = true;
}

void main();
