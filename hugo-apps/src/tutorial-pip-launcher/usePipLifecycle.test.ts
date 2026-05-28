// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPipSupported, cloneStylesIntoDocument } from './usePipLifecycle';

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
