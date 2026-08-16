// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPipSupported, cloneStylesIntoDocument, findPipSrc } from './usePipLifecycle';

describe('isPipSupported', () => {
  beforeEach(() => {
    delete (window as any).documentPictureInPicture;
  });

  it('returns false when API absent', () => {
    expect(isPipSupported()).toBe(false);
  });

  it('returns true when API present', () => {
    (window as any).documentPictureInPicture = { requestWindow: vi.fn() };
    expect(isPipSupported()).toBe(true);
  });
});

describe('cloneStylesIntoDocument', () => {
  it('clones <link rel="stylesheet"> nodes into the target head', () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'data:text/css,';
    document.head.appendChild(link);

    const target = document.implementation.createHTMLDocument('pip');
    cloneStylesIntoDocument(document, target);

    const cloned = target.head.querySelectorAll('link[rel="stylesheet"]');
    expect(cloned.length).toBe(1);
    expect(cloned[0].getAttribute('href')).toBe('data:text/css,');

    link.remove();
  });

  it('clones inline <style> nodes', () => {
    const style = document.createElement('style');
    style.textContent = '.foo { color: red; }';
    document.head.appendChild(style);

    const target = document.implementation.createHTMLDocument('pip');
    cloneStylesIntoDocument(document, target);

    const styles = target.head.querySelectorAll('style');
    expect(styles.length).toBeGreaterThanOrEqual(1);
    const found = Array.from(styles).some(s => s.textContent?.includes('.foo'));
    expect(found).toBe(true);

    style.remove();
  });
});

describe('findPipSrc (data-pip-src attribute)', () => {
  function withLauncher(pipSrc: string | null, fn: () => void) {
    const el = document.createElement('div');
    el.id = 'tutorial-pip-launcher';
    if (pipSrc !== null) el.dataset.pipSrc = pipSrc;
    document.body.appendChild(el);
    try { fn(); } finally { el.remove(); }
  }

  it('returns the hashed bundle URL from data-pip-src', () => {
    withLauncher('/js/tutorial-pip-Bz4vSMUV.js', () => {
      expect(findPipSrc(document)).toBe('/js/tutorial-pip-Bz4vSMUV.js');
    });
  });

  it('returns the un-hashed dev-fallback URL', () => {
    withLauncher('/js/tutorial-pip.js', () => {
      expect(findPipSrc(document)).toBe('/js/tutorial-pip.js');
    });
  });

  it('returns null when launcher element is absent', () => {
    expect(findPipSrc(document)).toBeNull();
  });

  it('returns null when data-pip-src attribute is empty', () => {
    withLauncher('', () => {
      expect(findPipSrc(document)).toBeNull();
    });
  });

  it('trims whitespace', () => {
    withLauncher('  /js/tutorial-pip-Bz4vSMUV.js  ', () => {
      expect(findPipSrc(document)).toBe('/js/tutorial-pip-Bz4vSMUV.js');
    });
  });
});
