// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

let document: Document;

beforeEach(() => {
  vi.resetModules();
  document = window.document;
  document.body.innerHTML = '';
});

it('binds focus on marker to highlight list item', async () => {
  document.body.innerHTML = `
    <div class="tut-hotspot-wrap">
      <img src="x.png" data-hotspots="1:10%,10%">
      <a class="tut-hotspot" href="#hs-x-1" aria-label="Callout 1" data-hotspot-n="1">1</a>
    </div>
    <ol>
      <li>Step one</li>
    </ol>`;
  const { initHotspots } = await import('../hotspots.js');
  initHotspots();
  const marker = document.querySelector('.tut-hotspot') as HTMLElement;
  marker.dispatchEvent(new Event('focus'));
  const li = document.querySelector('li');
  expect(li?.classList.contains('tut-hotspot--active')).toBe(true);
});
