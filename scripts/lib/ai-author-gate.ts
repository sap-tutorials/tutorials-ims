// scripts/lib/ai-author-gate.ts
//
// [#2761] Single decision point for whether the build's AI-author phase
// (AI-quiz expansion + json-render challenge specs) should run at all.
//
// Why this exists — two deploy-pipeline wins from the 2026-10-13 release retro:
//
//   1. A deploy build renders ~1400 tutorial bodies that the approuter then
//      DISCARDS (tutorial HTML is served from HANA BLOBs, not static files —
//      see CLAUDE.md). The expensive AI-author pass on that throwaway render is
//      pure waste. Setting SKIP_AI_AUTHOR=1 on the deploy path skips it; the
//      separate content rebuild (rebuild-content.yml) leaves the flag unset and
//      still generates quizzes for the HANA-served bodies that actually keep them.
//
//   2. When there is no AI Hub binding (no deploymentId resolvable), the quiz
//      generator fails fast per step but still consumes one AI_AUTHOR_BUILD_CAP
//      slot per attempt — up to 200 throw-and-log cycles per build. Resolving
//      the binding ONCE up front and skipping the whole phase (fail-open, one
//      warning) removes that dead work.
//
// Pure module — no I/O of its own; the settings resolver is injected so the
// decision is unit-testable without a real binding.

export interface AiAuthorGate {
  /** Run the AI-author phase (quiz + challenge) this build? */
  enabled: boolean;
  /** Human-readable reason, logged once by the caller. */
  reason: string;
}

interface ResolveArgs {
  /** Explicit override; when omitted, read from `env.SKIP_AI_AUTHOR`. */
  skip?: boolean;
  /** Environment source (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /**
   * Injected binding resolver — typically resolveChatLlmSettings from
   * packages/core/chat-settings-resolver.js. Returns { deploymentId } or
   * throws ("No deploymentId ...") when the AI Hub binding is absent.
   */
  resolveSettings: () => Promise<{ deploymentId?: string | null }>;
}

/**
 * Decide — once per build — whether the AI-author phase runs.
 *
 * Order of checks:
 *   1. SKIP_AI_AUTHOR set  → disabled, resolver NOT called (deploy builds).
 *   2. binding resolves    → enabled.
 *   3. binding missing/throws → disabled, fail-open (one warning, no throw loop).
 */
export async function resolveAiAuthorGate(args: ResolveArgs): Promise<AiAuthorGate> {
  const env = args.env ?? process.env;
  const skip = args.skip ?? isTruthy(env.SKIP_AI_AUTHOR);

  if (skip) {
    return { enabled: false, reason: 'SKIP_AI_AUTHOR is set — skipping AI-author phase (quiz + challenge)' };
  }

  try {
    const settings = await args.resolveSettings();
    if (!settings?.deploymentId) {
      return {
        enabled: false,
        reason: 'No deploymentId resolved for the SAP AI Hub binding — skipping AI-author phase (fail-open)',
      };
    }
    return { enabled: true, reason: 'AI Hub binding resolved — AI-author phase enabled' };
  } catch (err) {
    return {
      enabled: false,
      reason: `AI Hub binding unavailable (${(err as Error).message}) — skipping AI-author phase (fail-open)`,
    };
  }
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
}
