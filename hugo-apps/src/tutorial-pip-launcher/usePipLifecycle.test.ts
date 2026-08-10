// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPipSupported, cloneStylesIntoDocument, findPipScriptTag } from './usePipLifecycle';

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

describe('findPipScriptTag (#1604 content-hashed bundles)', () => {
  function withScripts(srcs: string[], fn: () => void) {
    // Build tags WITHOUT type="module" — findPipScriptTag matches on src only,
    // and happy-dom would otherwise try to fetch a module src on append and
    // spam NotSupportedError. A plain data-src carries the value we assert on.
    const added = srcs.map((src) => {
      const s = document.createElement('script');
      s.setAttribute('src', src);
      document.head.appendChild(s);
      return s;
    });
    try { fn(); } finally { added.forEach((s) => s.remove()); }
  }

  it('finds the hashed tutorial-pip bundle and ignores tutorial-pip-launcher', () => {
    withScripts(
      ['/js/tutorial-pip-launcher-OSztyx-x.js', '/js/tutorial-pip-Bz4vSMUV.js'],
      () => {
        const tag = findPipScriptTag(document);
        expect(tag).not.toBeNull();
        expect(tag!.getAttribute('src')).toBe('/js/tutorial-pip-Bz4vSMUV.js');
      },
    );
  });

  it('still matches the un-hashed dev-fallback filename', () => {
    withScripts(['/js/tutorial-pip.js', '/js/tutorial-pip-launcher.js'], () => {
      const tag = findPipScriptTag(document);
      expect(tag!.getAttribute('src')).toBe('/js/tutorial-pip.js');
    });
  });

  it('returns null when only the launcher bundle is present', () => {
    withScripts(['/js/tutorial-pip-launcher-OSztyx-x.js'], () => {
      expect(findPipScriptTag(document)).toBeNull();
    });
  });
});
