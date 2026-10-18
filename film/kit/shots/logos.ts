// A check sheet: every sponsor logo on black, as the end card will use them.
import { el, type Shot } from '../lib';
const L = '/film/assets/logos/';
const shot: Shot = {
  duration: 1,
  async setup() {
    const items: [string, string, string][] = [
      ['vobile.png', 'Vobile', ''], ['deepspace-ring.png', 'DeepSpace', 'DeepSpace'], ['roblox.svg', 'Roblox', ''],
      ['gemini-sparkle.svg', 'Gemini', 'Gemini'], ['vultr-white.svg', 'Vultr', ''], ['auth0-white.svg', 'Auth0', ''],
      ['tigerdata.svg', 'Tiger Data', ''], ['godaddy-registry.svg', 'GoDaddy Registry', ''], ['mlh.svg', 'MLH', ''],
    ];
    const grid = el('', 160, 160, '');
    grid.style.cssText += 'width:1600px;display:grid;grid-template-columns:repeat(3,1fr);gap:90px 60px;align-items:center;justify-items:center';
    for (const [file, name, word] of items) {
      const c = document.createElement('div');
      c.style.cssText = 'display:flex;align-items:center;gap:16px;height:110px;color:#f5f5f7;font-size:44px;font-weight:600;letter-spacing:-0.02em';
      const invert = file === 'godaddy-registry.svg' ? 'filter:brightness(0) invert(1);' : '';
      c.innerHTML = `<img src="${L}${file}" alt="${name}" style="max-height:${word ? 64 : 76}px;max-width:420px;${invert}">${word ? `<span>${word}</span>` : ''}`;
      grid.appendChild(c);
    }
    await new Promise((r) => setTimeout(r, 800));
  },
  frame() {},
};
export default shot;
