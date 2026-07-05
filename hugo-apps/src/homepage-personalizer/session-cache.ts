const KEY = 'sap-devs-homepage-personalized';
const TTL_MS = 5 * 60 * 1000;

export interface Envelope {
  hash: string;
  profile?: { role: string | null; deployment: string | null; cloud: string | null };
  verbOrder?: string[];
  forYou?: any[];
  teaserOrder?: string[];
  shelfOverrides?: Record<string, { reorder: string[]; hidden: string[] }>;
  videoFilterTags?: string[];
  rssFilterTags?: string[];
}

interface CacheRow { hash: string; payload: Envelope; at: number; }

export function readSessionCache(): CacheRow | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const row = JSON.parse(raw) as CacheRow;
    if (!row?.hash || !row?.payload) return null;
    if (Date.now() - row.at > TTL_MS) return null;
    return row;
  } catch { return null; }
}

export function writeSessionCache(payload: Envelope): void {
  try {
    const row: CacheRow = { hash: payload.hash, payload, at: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(row));
  } catch { /* quota — silent */ }
}
