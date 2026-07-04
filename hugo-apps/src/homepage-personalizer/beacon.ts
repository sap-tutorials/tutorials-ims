// hugo-apps/src/homepage-personalizer/beacon.ts
// (#763 Task 19) One navigator.sendBeacon per surface per session — aggregate
// signal for how many personalization surfaces are being applied.
// Idempotency is enforced client-side via sessionStorage to avoid double-counts
// across re-renders.

const KEY = 'sap-devs-homepage-beaconed';
const ENDPOINT = '/homepage/beaconApplied';

/** Emit a single beacon for `surface` once per browser session. */
export function beaconApplied(surface: string): void {
  try {
    const set = new Set<string>(JSON.parse(sessionStorage.getItem(KEY) || '[]'));
    if (set.has(surface)) return;
    set.add(surface);
    sessionStorage.setItem(KEY, JSON.stringify([...set]));
    if (typeof navigator?.sendBeacon === 'function') {
      // Send only the surface — server discards timestamps anyway, and
      // Date.now() in JS is a 13-digit number that overflows CDS Integer.
      const body = new Blob(
        [JSON.stringify({ surface })],
        { type: 'application/json' },
      );
      navigator.sendBeacon(ENDPOINT, body);
    }
  } catch { /* silent — never let beacon failures affect the page */ }
}
