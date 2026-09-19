import { ref, type Ref } from 'vue';
import { fetchMyFavorites } from './feed';
import { csrfFetch } from '@shared/csrf-fetch';

// #2393 — shared favorites store. One module-singleton reactive Set of
// composite keys, shared across every island mounted on the page, so favoriting
// in the grid reflects in the schedule/calendar without a reload.
export const favKey = (sourceType: string, sref: string): string => `${sourceType}:${sref}`;

export const favSet: Ref<Set<string>> = ref(new Set<string>());

export function isFavorite(sourceType: string, sref: string): boolean {
  return favSet.value.has(favKey(sourceType, sref));
}

export async function loadFavorites(): Promise<void> {
  const { favorites } = await fetchMyFavorites();
  favSet.value = new Set(favorites.map((f) => favKey(f.sourceType, f.sessionRef)));
}

export async function toggleFavorite(sourceType: string, sref: string): Promise<void> {
  const key = favKey(sourceType, sref);
  const had = favSet.value.has(key);
  // Optimistic: mutate the Set immediately, revert if the POST fails.
  const next = new Set(favSet.value);
  if (had) next.delete(key); else next.add(key);
  favSet.value = next;
  try {
    const r = await csrfFetch('/api/toggleSessionFavorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sourceType, sessionRef: sref }),
    });
    if (!r.ok) throw new Error(`toggle failed ${r.status}`);
  } catch {
    const revert = new Set(favSet.value);
    if (had) revert.add(key); else revert.delete(key);
    favSet.value = revert;
  }
}
