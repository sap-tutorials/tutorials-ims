// hugo-apps/src/featured-topics-carousel/window-storage.ts
// #1782 — localStorage persistence for the Top Tutorials window selector.

const KEY = 'sap-devs-homepage-top-tutorials-window';
export const WINDOW_OPTIONS = [90, 180, 360] as const;
export const DEFAULT_WINDOW = 180;

export function readLocalStorageWindow(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (WINDOW_OPTIONS as readonly number[]).includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeLocalStorageWindow(w: number): void {
  try { localStorage.setItem(KEY, String(w)); } catch { /* private mode */ }
}
