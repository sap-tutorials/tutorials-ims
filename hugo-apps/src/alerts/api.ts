// hugo-apps/src/alerts/api.ts
import type { ApiAlertsResponse } from './types';
import { selectEndpoint } from './endpoint-select';

export async function fetchAlerts(authenticated: boolean): Promise<ApiAlertsResponse> {
  const url = selectEndpoint(authenticated);
  try {
    const res = await fetch(url, {
      credentials: authenticated ? 'include' : 'omit',
      headers: { 'accept': 'application/json' },
    });
    if (!res.ok) return { alerts: [], fetchedAt: new Date().toISOString() };
    return await res.json();
  } catch {
    // Silent failure — bell stays empty rather than showing an error.
    return { alerts: [], fetchedAt: new Date().toISOString() };
  }
}
