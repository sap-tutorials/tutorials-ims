import type { AdvocateFilterState } from '../shared/advocate-types';

const HASH_KEYS: (keyof AdvocateFilterState)[] = ['region', 'topic', 'q'];

export function readHash(): Partial<AdvocateFilterState> {
  if (typeof window === 'undefined') return {};
  const h = window.location.hash || '';
  const params = new URLSearchParams(h.replace(/^#/, ''));
  const out: Partial<AdvocateFilterState> = {};
  for (const k of HASH_KEYS) {
    const v = params.get(k);
    if (v != null && v !== '') (out as any)[k] = v;
  }
  return out;
}

export function writeHash(state: AdvocateFilterState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (state.region !== 'ALL') params.set('region', state.region);
  if (state.topic  !== 'ALL') params.set('topic', state.topic);
  if (state.q)               params.set('q', state.q);
  const next = params.toString();
  const target = next ? '#' + next : window.location.pathname + window.location.search;
  if (window.location.hash.replace(/^#/, '') !== next) {
    history.replaceState(null, '', target);
  }
}
