// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeChannel {
  static instances: FakeChannel[] = [];
  listeners: ((e: MessageEvent) => void)[] = [];
  constructor(public name: string) { FakeChannel.instances.push(this); }
  addEventListener(_: string, cb: any) { this.listeners.push(cb); }
  postMessage(data: any) {
    for (const c of FakeChannel.instances) if (c !== this) {
      for (const l of c.listeners) l({ data } as MessageEvent);
    }
  }
  close() {}
}

beforeEach(() => {
  FakeChannel.instances = [];
  (globalThis as any).BroadcastChannel = FakeChannel;
  sessionStorage.clear();
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ hash: 'new-hash', verbOrder: ['build'] }),
  });
});

describe('prefs-broadcast', () => {
  it('re-fetches and calls onNew when new hash differs', async () => {
    const { subscribeBroadcast, broadcastPreferencesChanged } = await import('../prefs-broadcast');
    const onNew = vi.fn();
    subscribeBroadcast('old-hash', onNew);
    broadcastPreferencesChanged();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onNew).toHaveBeenCalled();
    expect(onNew.mock.calls[0][0].hash).toBe('new-hash');
  });

  it('no-ops when new hash matches (payload-hash guard)', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ hash: 'same' }),
    });
    const { subscribeBroadcast, broadcastPreferencesChanged } = await import('../prefs-broadcast');
    const onNew = vi.fn();
    subscribeBroadcast('same', onNew);
    broadcastPreferencesChanged();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onNew).not.toHaveBeenCalled();
  });
});
