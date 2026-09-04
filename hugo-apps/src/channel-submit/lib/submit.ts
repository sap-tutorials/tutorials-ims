import { csrfFetch } from '@shared/csrf-fetch';

export type ChannelProposal = {
  kind: 'ADD' | 'EDIT' | 'REMOVE';
  targetChannel_ID?: string;
  proposed: string; // JSON string of curated fields
  rationale: string;
};

// Do NOT trust res.ok: approuter returns 200 + HTML login page for anon on the xsuaa /auth/user route.
export async function probeAuth(): Promise<boolean> {
  try {
    const res = await fetch('/auth/user', { credentials: 'include' });
    if (!res.ok) return false;
    if (!/application\/json/i.test(res.headers.get('content-type') || '')) return false;
    const body = await res.json();
    return Boolean(body && body.authenticated);
  } catch {
    return false;
  }
}

export async function submitChannelProposal(payload: ChannelProposal): Promise<void> {
  const res = await csrfFetch('/channel-submissions/Submissions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Submission failed: ${res.status}`);
}
