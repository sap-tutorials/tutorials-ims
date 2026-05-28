import { CAMERA_CONSTRAINTS, type FeatureId } from './constants';
import { addSession, removeSession } from './prefs-store';

let stream: MediaStream | null = null;
let inflight: Promise<MediaStream> | null = null;
const consumers = new Set<FeatureId>();

export function getActiveConsumers(): FeatureId[] { return [...consumers]; }

export async function acquire(consumer: FeatureId): Promise<MediaStream> {
  if (stream) {
    consumers.add(consumer);
    addSession(consumer);
    return stream;
  }
  if (inflight) {
    const s = await inflight;
    consumers.add(consumer);
    addSession(consumer);
    return s;
  }
  inflight = navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS).then((s) => {
    stream = s; inflight = null; return s;
  }).catch((err) => { inflight = null; throw err; });
  const s = await inflight;
  consumers.add(consumer);
  addSession(consumer);
  return s;
}

export function release(consumer: FeatureId): void {
  if (!consumers.has(consumer)) return;
  consumers.delete(consumer);
  removeSession(consumer);
  if (consumers.size === 0 && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

// Test-only.
export function _resetForTests(): void {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; inflight = null; consumers.clear();
}
