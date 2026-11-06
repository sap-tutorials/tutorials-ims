// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kbdAriaLabel, kbdLabel, applyOs } from '../../../hugo/assets/js/kbd-os.js';

function makeKbd(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('kbd');
  el.setAttribute('data-kbd', '');
  for (const [k, v] of Object.entries(attrs)) {
    el.dataset[k] = v;
  }
  return el;
}

describe('kbdAriaLabel', () => {
  it('replaces ⌘ with Command', () => {
    expect(kbdAriaLabel('⌘S')).toBe('Command S');
  });

  it('⌘⇧P → Command Shift P', () => {
    expect(kbdAriaLabel('⌘⇧P')).toBe('Command Shift P');
  });

  it('⌃⌥T → Control Option T', () => {
    expect(kbdAriaLabel('⌃⌥T')).toBe('Control Option T');
  });

  it('↩ → Return', () => {
    expect(kbdAriaLabel('↩')).toBe('Return');
  });

  it('Ctrl+Shift+P is unchanged (already readable)', () => {
    expect(kbdAriaLabel('Ctrl+Shift+P')).toBe('Ctrl+Shift+P');
  });

  it('collapses multiple spaces after substitution', () => {
    // ⌘⇧ produces "Command Shift" then P appended — no double space when adjacent symbols
    expect(kbdAriaLabel('⌘⇧P')).not.toMatch(/  /);
  });
});

describe('kbdLabel', () => {
  it('macOS returns data-mac value', () => {
    const el = makeKbd({ mac: '⌘S', win: 'Ctrl+S', linux: 'Ctrl+S' });
    expect(kbdLabel(el, 'macOS')).toBe('⌘S');
  });

  it('Windows returns data-win value', () => {
    const el = makeKbd({ mac: '⌘S', win: 'Ctrl+S', linux: 'Ctrl+S' });
    expect(kbdLabel(el, 'Windows')).toBe('Ctrl+S');
  });

  it('Linux returns data-linux value', () => {
    const el = makeKbd({ mac: '⌘S', win: 'Ctrl+S', linux: 'Ctrl+S' });
    expect(kbdLabel(el, 'Linux')).toBe('Ctrl+S');
  });

  it('Linux falls back to data-win when data-linux absent', () => {
    const el = makeKbd({ mac: '⌘S', win: 'Ctrl+S' });
    // data-linux is not set
    expect(kbdLabel(el, 'Linux')).toBe('Ctrl+S');
  });

  it('BAS uses the Windows form', () => {
    const el = makeKbd({ mac: '⌘S', win: 'Ctrl+S', linux: 'Ctrl+S' });
    expect(kbdLabel(el, 'BAS')).toBe('Ctrl+S');
  });
});

describe('applyOs — DOM integration', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = makeKbd({ win: 'Ctrl+S', mac: '⌘S', linux: 'Ctrl+S' });
    el.textContent = 'Ctrl+S';
    document.body.appendChild(el);
  });

  afterEach(() => {
    document.body.removeChild(el);
  });

  it('applyOs("macOS") sets textContent to ⌘S', () => {
    applyOs('macOS');
    expect(el.textContent).toBe('⌘S');
  });

  it('applyOs("macOS") then applyOs("Windows") reverts to Ctrl+S', () => {
    applyOs('macOS');
    expect(el.textContent).toBe('⌘S');
    applyOs('Windows');
    expect(el.textContent).toBe('Ctrl+S');
  });

  it('applyOs("macOS") sets aria-label to Command S', () => {
    applyOs('macOS');
    expect(el.getAttribute('aria-label')).toBe('Command S');
  });

  it('applyOs("Windows") sets aria-label to Ctrl+S', () => {
    applyOs('Windows');
    expect(el.getAttribute('aria-label')).toBe('Ctrl+S');
  });

  it('applyOs("Linux") falls back to win form when linux absent', () => {
    const linuxEl = makeKbd({ win: 'Ctrl+P', mac: '⌘P' });
    linuxEl.textContent = 'Ctrl+P';
    document.body.appendChild(linuxEl);
    applyOs('Linux');
    expect(linuxEl.textContent).toBe('Ctrl+P');
    document.body.removeChild(linuxEl);
  });
});
