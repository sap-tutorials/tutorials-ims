import type { FeedbackSubmission } from './types';

export async function probeAuth(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    return r.ok;
  } catch {
    return false;
  }
}

export async function submitFeedback(
  payload: FeedbackSubmission
): Promise<{ submissionId: string }> {
  const r = await fetch('/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}
