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
});
