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

describe('pickInitialOs (#2820 initial selection)', () => {
  it('honors an explicit stored preference even if this tutorial does not offer it', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    // Stored BAS, tutorial offers only Windows/macOS — stored still wins.
    expect(__test__.pickInitialOs('BAS', 'Windows', ['Windows', 'macOS'])).toBe('BAS');
  });

  it('uses the detected OS when the tutorial offers it', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.pickInitialOs(null, 'macOS', ['Windows', 'macOS', 'Linux'])).toBe('macOS');
  });

  it('snaps to the first offered OS when the detected OS is not offered (no blank steps)', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    // Detected Windows, tutorial offers only Linux/macOS → land on Linux, not a
    // placeholder-in-every-group Windows.
    expect(__test__.pickInitialOs(null, 'Windows', ['Linux', 'macOS'])).toBe('Linux');
  });

  it('uses the detected OS on a legacy page with no picker buttons', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.pickInitialOs(null, 'Windows', [])).toBe('Windows');
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

describe('activate — missing-OS placeholder (#2820)', () => {
  // #2820: when the active OS has no panel in a group, we must NOT swap in
  // another OS's content (the old FALLBACK_CHAIN behavior). We show a
  // placeholder strip and render no panel body, so a user who selects Windows
  // on a Linux/macOS-only step sees "not available here", not macOS content.
  beforeEach(() => {
    resetBody();
    document.body.appendChild(buildOsOptions([
      { os: 'Windows', body: 'W' },
      { os: 'macOS',   body: 'M' },
    ]));
  });

  it('activates no panel when the requested OS has no panel (no foreign content)', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');
    // No panel is marked active — the step shows nothing for the missing OS.
    expect(document.querySelector('[data-os-active]')).toBeNull();
  });

  it('renders a "not available" placeholder strip for the missing OS', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');
    const strip = document.querySelector('ui5-message-strip');
    expect(strip).not.toBeNull();
    // New spec phrasing: announce absence, do NOT advertise a substitute OS.
    expect(strip?.textContent).toBe('No Linux instructions for this step.');
    // data-os-fallback-strip is load-bearing for clearStrip's selector.
    expect(strip?.hasAttribute('data-os-fallback-strip')).toBe(true);
  });

  it('does NOT render a message strip on exact match', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('activates the matching panel and shows no strip on exact match', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('macOS');
    const active = document.querySelectorAll('[data-os-active]');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.os).toBe('macOS');
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('clears prior placeholder strip on reactivation', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Linux');         // creates a placeholder strip
    __test__.activate('Windows');       // exact match — strip should be removed
    expect(document.querySelector('ui5-message-strip')).toBeNull();
  });

  it('shows a placeholder (not BAS content) when only BAS is present and Windows is requested', async () => {
    resetBody();
    document.body.appendChild(buildOsOptions([{ os: 'BAS', body: 'B' }]));
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    __test__.activate('Windows');
    // No cross-OS fallback: BAS content must NOT be shown for a Windows request.
    expect(document.querySelector('[data-os-active]')).toBeNull();
    const strip = document.querySelector('ui5-message-strip');
    expect(strip?.textContent).toBe('No Windows instructions for this step.');
  });

  it('returns the exact OS when a matching panel exists (#2703)', async () => {
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.activate('Windows')).toBe('Windows');
  });

  it('returns the requested OS even when it has no panel (#2820 — no OS swap)', async () => {
    // Fixture: only Windows + macOS panels exist. Requesting Linux must keep the
    // picker selection on Linux (so the user sees the placeholder under Linux),
    // not silently re-point it to a foreign OS.
    const { __test__ } = await import('../../hugo/assets/js/os-toggle');
    expect(__test__.activate('Linux')).toBe('Linux');
  });
});
