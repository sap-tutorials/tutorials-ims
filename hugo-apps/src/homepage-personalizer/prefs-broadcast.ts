import { writeSessionCache, type Envelope } from './session-cache';

const CH_NAME = 'sap-devs-prefs';
const STORAGE_KEY = 'sap-devs-prefs-touched';
const ENDPOINT = '/homepage/personalized';
const MSG = { type: 'preferences-changed' } as const;

export function broadcastPreferencesChanged(): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CH_NAME);
      ch.postMessage(MSG);
      ch.close();
    }
  } catch { /* silent */ }
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {}
}

export function subscribeBroadcast(
  currentHash: string,
  onNew: (env: Envelope) => void
): () => void {
  const cleanups: (() => void)[] = [];

  async function refetch() {
    try {
      const r = await fetch(ENDPOINT, { credentials: 'include' });
      if (!r.ok) return;
      const next = (await r.json()) as Envelope;
      if (!next?.hash || next.hash === currentHash) return;
      writeSessionCache(next);
      currentHash = next.hash;
      onNew(next);
    } catch { /* silent */ }
  }

  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CH_NAME);
    const handler = (e: MessageEvent) => {
      if ((e as any).data?.type === 'preferences-changed') void refetch();
    };
    ch.addEventListener('message', handler);
    cleanups.push(() => { try { ch.close(); } catch {} });
  }

  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) void refetch();
  };
  window.addEventListener('storage', storageHandler);
  cleanups.push(() => window.removeEventListener('storage', storageHandler));

  return () => cleanups.forEach((f) => f());
}
