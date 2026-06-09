// @vitest-environment happy-dom
// test/unit/os-toggle.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Lazy-import inside tests so the module's `init()` IIFE runs in a known DOM state.

function buildOsOptions(panels: Array<{ os: string; body: string }>): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'os-options';
  wrapper.setAttribute('data-os-options', '');
  for (const p of panels) {
    const el = document.createElement('div');
    el.className = 'os-panel';
    el.setAttribute('data-os', p.os);
    el.textContent = p.body;
    wrapper.appendChild(el);
  }
  return wrapper;
}

function resetBody() {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

describe('detectDefaultOs', () => {
  beforeEach(() => {
    resetBody();
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: '', configurable: true });
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  });

  it('returns the localStorage preference when set', async () => {
    localStorage.setItem('os-preference', 'macOS');
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('macOS');
  });

  it('returns Windows from userAgent when no preference', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('Windows');
  });

  it('returns macOS from userAgent', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true });
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('macOS');
  });

  it('returns Linux from userAgent', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64)', configurable: true });
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('Linux');
  });

  it('returns BAS when document.referrer matches BAS host', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://my-org.applicationstudio.cloud.sap/', configurable: true });
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('BAS');
  });

  it('falls back to Windows when nothing matches', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: '', configurable: true });
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.detectDefaultOs()).toBe('Windows');
  });
});

describe('activate', () => {
  beforeEach(() => {
    resetBody();
    document.body.appendChild(buildOsOptions([
      { os: 'Windows', body: 'W' },
      { os: 'macOS',   body: 'M' },
      { os: 'Linux',   body: 'L' },
    ]));
  });

  it('sets data-os-options-hydrated on the wrapper', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    const wrapper = document.querySelector('[data-os-options]');
    expect(wrapper?.hasAttribute('data-os-options-hydrated')).toBe(true);
  });

  it('flags only the matching panel with data-os-active', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('macOS');
    const active = document.querySelectorAll('[data-os-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.os).toBe('macOS');
  });

  it('updates active panel on subsequent calls', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    __test__.activate('Linux');
    const active = document.querySelectorAll('[data-os-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.os).toBe('Linux');
  });
});

describe('OS_VALUES', () => {
  it('exports the four canonical OS values in fixed order', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.OS_VALUES).toEqual(['Windows', 'macOS', 'Linux', 'BAS']);
  });
});

describe('selectPickerItem (cross-tab sync helper)', () => {
  beforeEach(() => {
    resetBody();
  });

  it('updates selected attributes without attaching listeners', async () => {
    // Build a picker fixture with the four items
    const picker = document.createElement('div');
    picker.setAttribute('data-os-picker', '');
    const seg = document.createElement('ui5-segmented-button');
    for (const os of ['Windows', 'macOS', 'Linux', 'BAS']) {
      const item = document.createElement('ui5-segmented-button-item');
      item.setAttribute('data-os', os);
      seg.appendChild(item);
    }
    picker.appendChild(seg);
    document.body.appendChild(picker);

    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.selectPickerItem(picker, 'macOS');

    const items = seg.querySelectorAll('ui5-segmented-button-item');
    expect(items[0].hasAttribute('selected')).toBe(false); // Windows
    expect(items[1].hasAttribute('selected')).toBe(true);  // macOS
    expect(items[2].hasAttribute('selected')).toBe(false); // Linux
    expect(items[3].hasAttribute('selected')).toBe(false); // BAS

    // Switching selection clears the previous and sets the new — no duplicates.
    __test__.selectPickerItem(picker, 'Linux');
    const selectedAfterSwitch = seg.querySelectorAll('[selected]');
    expect(selectedAfterSwitch.length).toBe(1);
    expect((selectedAfterSwitch[0] as HTMLElement).dataset.os).toBe('Linux');
  });
});

describe('activate — fallback chain', () => {
  beforeEach(() => {
    resetBody();
    document.body.appendChild(buildOsOptions([
      { os: 'Windows', body: 'W' },
      { os: 'macOS',   body: 'M' },
    ]));
  });

  it('falls back from Linux -> macOS when no Linux panel exists', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');
    const active = document.querySelector('[data-os-active]') as HTMLElement;
    expect(active?.dataset.os).toBe('macOS');
  });

  it('renders a ui5-message-strip when fallback fires', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');
    const strip = document.querySelector('ui5-message-strip');
    expect(strip).not.toBeNull();
    // Exact-format assertion locks down the spec phrasing (em-dash, "instructions for this step", "showing").
    expect(strip?.textContent).toBe('No Linux instructions for this step — showing macOS.');
    // data-os-fallback-strip is load-bearing for clearStrip's selector.
    expect(strip?.hasAttribute('data-os-fallback-strip')).toBe(true);
  });

  it('does NOT render a message strip on exact match', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('clears prior message strip on reactivation', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');         // creates a strip
    __test__.activate('Windows');       // exact match — strip should be removed
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('falls back through chain when only BAS is present', async () => {
    resetBody();
    document.body.appendChild(buildOsOptions([{ os: 'BAS', body: 'B' }]));
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    const active = document.querySelector('[data-os-active]') as HTMLElement;
    expect(active?.dataset.os).toBe('BAS');
    // Strip must announce the deep-chain fallback, not just the active-panel state.
    const strip = document.querySelector('ui5-message-strip');
    expect(strip?.textContent).toBe('No Windows instructions for this step — showing BAS.');
  });
});
