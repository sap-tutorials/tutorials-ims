// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquire, release, getActiveConsumers, _resetForTests } from './camera-session';

function fakeTrack() { return { stop: vi.fn() }; }
function fakeStream(tracks = [fakeTrack(), fakeTrack()]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

describe('camera-session', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    _resetForTests();
    getUserMedia = vi.fn().mockResolvedValue(fakeStream());
    (navigator as any).mediaDevices = { getUserMedia };
  });
  afterEach(() => vi.restoreAllMocks());

  it('first acquire calls getUserMedia and returns a stream', async () => {
    const s = await acquire('eye');
    expect(s).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers().sort()).toEqual(['eye']);
  });

  it('second acquire reuses the same stream', async () => {
    const s1 = await acquire('eye');
    const s2 = await acquire('hand');
    expect(s1).toBe(s2);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers().sort()).toEqual(['eye', 'hand']);
  });

  it('release of one keeps stream alive for the other', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    getUserMedia.mockResolvedValue(fakeStream(tracks));
    await acquire('eye'); await acquire('hand');
    release('eye');
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(getActiveConsumers()).toEqual(['hand']);
  });

  it('releasing the last consumer stops all tracks', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    getUserMedia.mockResolvedValue(fakeStream(tracks));
    await acquire('eye');
    release('eye');
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(tracks[1].stop).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers()).toEqual([]);
  });

  it('rejects when getUserMedia throws and leaves no active consumer', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(acquire('eye')).rejects.toThrow();
    expect(getActiveConsumers()).toEqual([]);
  });

  it('idempotent release is harmless', async () => {
    await acquire('eye'); release('eye'); release('eye');
    expect(getActiveConsumers()).toEqual([]);
  });
});
