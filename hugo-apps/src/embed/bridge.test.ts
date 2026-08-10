// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbedBridge } from './bridge';

function fakeWindow() {
  return { postMessage: vi.fn() } as unknown as Window;
}

describe('createEmbedBridge', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('emits sap:tutorial:ready to the resolved host origin, never "*"', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.emitReady({ slug: 's', title: 't', stepCount: 5 });
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'sap:tutorial:ready', slug: 's', title: 't', stepCount: 5 },
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('relays tutorial:step-change as sap:tutorial:step-change', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-change', { detail: { stepIndex: 3 } }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sap:tutorial:step-change', stepIndex: 3 }),
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('accepts an inbound goto from an allowed origin and re-dispatches embed:goto', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:goto', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://trial.sap.com',
      data: { type: 'sap:tutorial:goto', stepIndex: 4 },
    }));
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ stepIndex: 4 });
    b.destroy();
  });

  it('ignores an inbound message from a foreign origin', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:goto', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example.com',
      data: { type: 'sap:tutorial:goto', stepIndex: 4 },
    }));
    expect(spy).not.toHaveBeenCalled();
    b.destroy();
  });

  it('destroy() removes listeners (no relay after destroy)', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.destroy();
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-change', { detail: { stepIndex: 9 } }));
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('emitCompleted() posts sap:tutorial:completed to the host origin', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.emitReady({ slug: 's', title: 't', stepCount: 3 });
    (target.postMessage as any).mockClear();
    b.emitCompleted();
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'sap:tutorial:completed', slug: 's' },
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('auto-emits sap:tutorial:completed when the final step is completed', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.emitReady({ slug: 's', title: 't', stepCount: 2 });
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-completed', { detail: { stepNumber: 2 } }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sap:tutorial:step-completed', stepIndex: 2 }),
      'https://trial.sap.com',
    );
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'sap:tutorial:completed', slug: 's' },
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('does not auto-emit completed on a non-final step', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.emitReady({ slug: 's', title: 't', stepCount: 2 });
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-completed', { detail: { stepNumber: 1 } }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sap:tutorial:step-completed', stepIndex: 1 }),
      'https://trial.sap.com',
    );
    expect(target.postMessage).not.toHaveBeenCalledWith(
      { type: 'sap:tutorial:completed', slug: 's' },
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('re-dispatches embed:set-embed for an inbound set-embed from an allowed origin', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:set-embed', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://trial.sap.com',
      data: { type: 'sap:tutorial:set-embed', mode: 'compact' },
    }));
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ mode: 'compact' });
    b.destroy();
  });

  it('re-dispatches embed:set-theme for an inbound set-theme dark from an allowed origin', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:set-theme', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://trial.sap.com',
      data: { type: 'sap:tutorial:set-theme', theme: 'dark' },
    }));
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ theme: 'dark' });
    b.destroy();
  });

  it('ignores an inbound set-theme with an invalid theme value', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:set-theme', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://trial.sap.com',
      data: { type: 'sap:tutorial:set-theme', theme: 'invalid' },
    }));
    expect(spy).not.toHaveBeenCalled();
    b.destroy();
  });
});
