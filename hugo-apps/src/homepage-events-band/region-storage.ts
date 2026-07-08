// hugo-apps/src/homepage-events-band/region-storage.ts
// #1030 — localStorage helpers for the events-band region chip.

import type { Region } from './tz-to-region';

const KEY = 'sap-devs-homepage-events-region';
const VALID: Region[] = ['AMERICAS', 'EMEA', 'APJ', 'VIRTUAL', 'ALL'];

export function readLocalStorageRegion(): Region | null {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v as Region) ? (v as Region) : null;
  } catch {
    return null;
  }
}

export function writeLocalStorageRegion(r: Region): void {
  try { localStorage.setItem(KEY, r); } catch { /* private mode */ }
}
