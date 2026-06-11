// hugo-apps/src/tutorial-branches/decide.ts
//
// Issue #172 PR 3 — fetch branch decisions for the current tutorial.
// Memoizes the in-flight Promise so multiple components share one API call.
//
// Spec: docs/superpowers/specs/2026-06-10-172-branching-pr3-tutorial-branches-design.md §4.4

export interface BranchPointDecision {
  id: string;
  recommendation: {
    picked: string;
    reason: { kind: string; source?: string; scores?: Array<{ key: string; score: number }> };
    confidence: number;
  } | null;
}

export interface SkipPointDecision {
  stepNumber: number;
  skip: boolean;
  reason: { kind: string; source?: string };
  skipLabel?: string;
  skipReason?: string;
}

export interface DecideResponse {
  branchPoints: BranchPointDecision[];
  skipPoints: SkipPointDecision[];
}

const TIMEOUT_MS = 5000;

let inflight: Promise<DecideResponse | null> | null = null;

export async function getDecisions(slug: string): Promise<DecideResponse | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`/api/branches/decide?slug=${encodeURIComponent(slug)}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
  return inflight;
}

export function __resetForTest(): void { inflight = null; }

export interface BranchOverride { groupKey: string; branchKey: string; }

export function readBranchOverride(): BranchOverride | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('branch');
  if (!raw) return null;
  const m = raw.match(/^([^:]+):(.+)$/);
  if (!m) return null;
  return { groupKey: m[1], branchKey: m[2] };
}
