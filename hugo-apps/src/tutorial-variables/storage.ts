// hugo-apps/src/tutorial-variables/storage.ts
//
// Client-side persistence for tutorial variables.
//
// Key scheme:
//   tutvar:<missionSlug>:<name>  — mission-scoped (shared across all tutorials in the mission)
//   tutvar:<tutorialSlug>:<name> — tutorial-scoped (this tutorial only)
//
// readValue returns the most-specific value:
//   mission key (if missionSlug non-empty and key exists) → tutorial key → null
//
// writeValue always writes the tutorial key; also writes the mission key when
// missionSlug is a non-empty string.
//
// All localStorage access is wrapped in try/catch so private-mode,
// storage-quota, or disabled-storage environments never throw into the island.

export interface StorageCtx {
  missionSlug?: string;
  tutorialSlug: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// readValue
// ──────────────────────────────────────────────────────────────────────────────

export function readValue(name: string, ctx: StorageCtx): string | null {
  try {
    if (ctx.missionSlug) {
      const missionKey = `tutvar:${ctx.missionSlug}:${name}`;
      const missionVal = localStorage.getItem(missionKey);
      if (missionVal !== null) return missionVal;
    }
    const tutorialKey = `tutvar:${ctx.tutorialSlug}:${name}`;
    return localStorage.getItem(tutorialKey);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// writeValue
// ──────────────────────────────────────────────────────────────────────────────

export function writeValue(name: string, value: string, ctx: StorageCtx): void {
  try {
    const tutorialKey = `tutvar:${ctx.tutorialSlug}:${name}`;
    localStorage.setItem(tutorialKey, value);

    if (ctx.missionSlug) {
      const missionKey = `tutvar:${ctx.missionSlug}:${name}`;
      localStorage.setItem(missionKey, value);
    }
  } catch {
    // Private mode / quota / disabled storage — fail silently
  }
}
