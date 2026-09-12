/**
 * KTT server client — best-effort, never throws into the UI.
 * Uses native fetch (Node/browser built-in — no axios or other HTTP libs).
 *
 * Auth probe gotcha: /auth/user is cached by Akamai so r.ok is unreliable.
 * MUST parse JSON and check body.authenticated === true.
 */

import type { KttProgress } from './progress';

/**
 * Returns true when the current user is authenticated.
 * Probes /auth/user, parses JSON, checks body.authenticated.
 * Does NOT rely on r.ok (Akamai caches /auth/user).
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user');
    const body = await r.json();
    return body.authenticated === true;
  } catch {
    return false;
  }
}

/**
 * Notify the server that a lesson was completed.
 * Best-effort: failures are caught and resolve to null.
 */
export async function completeLesson(
  apiUrl: string,
  payload: { lessonSlug: string; legacyId: number; title: string },
): Promise<{ ok: boolean; alreadyDone: boolean } | null> {
  try {
    const r = await fetch(`${apiUrl}/completeLesson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Sync local progress to the server and receive the merged remote copy.
 * Best-effort: failures are caught and resolve to null.
 */
export async function syncProgress(
  apiUrl: string,
  local: KttProgress,
): Promise<{ xp: number; streak: number; mastered: string[] } | null> {
  try {
    const r = await fetch(`${apiUrl}/syncProgress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localJson: JSON.stringify(local) }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a banter line from Kasimir for the given context.
 * Best-effort: failures return null so the UI falls back to scripted lines.
 */
export async function fetchBanter(
  apiUrl: string,
  context: string,
): Promise<string | null> {
  try {
    const r = await fetch(`${apiUrl}/banter?context=${encodeURIComponent(context)}`);
    if (!r.ok) return null;
    const body = await r.json();
    return typeof body.value === 'string' ? body.value : null;
  } catch {
    return null;
  }
}
