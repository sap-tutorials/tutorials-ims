import type { ApiAlert } from './types';

export function filterVisible(alerts: ApiAlert[], dismissedSet: Set<string>): ApiAlert[] {
  return alerts.filter(a => !dismissedSet.has(a.id));
}

export function readDismissedSet(): Set<string> {
  const set = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('alerts.dismissed:')) {
        set.add(k.slice('alerts.dismissed:'.length));
      }
    }
  } catch { /* localStorage blocked: empty set */ }
  return set;
}

export function dismiss(id: string): void {
  try { localStorage.setItem('alerts.dismissed:' + id, '1'); } catch { /* ignore */ }
}
