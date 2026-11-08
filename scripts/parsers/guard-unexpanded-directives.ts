// scripts/parsers/guard-unexpanded-directives.ts
//
// Build-time safety net: detect directive tokens that survived UNEXPANDED in a
// composed tutorial body. A registered directive left as literal `:name[…]`,
// `::name[…]`, or `:::name` text means the directive registry was not populated
// when composeTutorial ran (e.g. a module-load failure skipping a self-register),
// so the raw token would be published and rendered as literal prose.
//
// This has shipped silently before: the directive-ui-instructions page served
// raw `:ui[…]` tokens through a full rebuild because the compose registry was
// effectively empty for the UI directives. The lint step's `directive-unknown`
// warning runs in a DIFFERENT process (no registration import) and is advisory,
// so it did NOT fail the build. This guard runs in the COMPOSE process and is
// meant to be wired to fail the build loudly.
//
// False-positive safety: the directive demo tutorials intentionally SHOW the
// syntax inside inline code spans and fenced code blocks. Those are masked /
// skipped so only a token in live prose — one that SHOULD have expanded — is
// flagged.

import { maskInlineCode } from './directives.js';

/**
 * Canonical set of directive names that MUST expand at compose time. This is a
 * STATIC list on purpose: the guard must not be driven by the live registry,
 * because the failure it guards against is *registration not happening* — if we
 * derived the names from getRegistry() an unregistered directive would simply be
 * absent from the match set and the guard would pass while the raw token ships
 * (exactly how the directive-ui-instructions regression slipped through).
 *
 * Excludes `qa-only`: it legitimately survives as a stripped/passthrough marker
 * depending on channel, so a surviving `:::qa-only` is not a failure.
 * Keep in sync with the directive modules under ./ (a drift test guards this).
 */
export const EXPECTED_DIRECTIVE_NAMES: readonly string[] = [
  'api', 'ask', 'cast', 'compare', 'details', 'diagram', 'figure', 'help',
  'hint', 'icon', 'image', 'include', 'kbd', 'menu', 'note', 'requires',
  'result', 'since', 'solution', 'spoiler', 'troubleshoot', 'tutorial', 'ui',
  'walkthrough',
];

/**
 * Scan a composed tutorial body for unexpanded tokens of the given directive
 * names. Returns the list of offending tokens (empty = clean).
 *
 * @param body  The post-compose body (expandDirectives already ran).
 * @param names Directive names that SHOULD have expanded. Pass a STATIC list
 *              (EXPECTED_DIRECTIVE_NAMES), NOT the live registry — see above.
 */
export function findUnexpandedDirectives(
  body: string,
  names: Iterable<string> = EXPECTED_DIRECTIVE_NAMES,
): string[] {
  const directiveNames = [...names].filter((n) => /^[a-z][a-z0-9-]*$/.test(n));
  if (directiveNames.length === 0) return [];
  // :name[  /  ::name[  /  :::name  — a leading colon run (1-3) + name + ( [ or EOL-ish ).
  // Anchored on the known names so arbitrary prose colons don't match.
  const alt = directiveNames.map((n) => n.replace(/[-]/g, '\\$&')).join('|');
  const tokenRe = new RegExp(`(?<![:\\w]):{1,3}(?:${alt})(?:\\[|\\b)`, 'g');

  // Strip HTML comments first (may span lines). Comment bodies are not rendered
  // and routinely contain directive EXAMPLES — e.g. directive-authoring-aids'
  // `<!-- The :::qa-only block above … -->`. Replace with blank lines so line
  // numbers / fence state are preserved.
  const commentless = body.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

  const lines = commentless.split('\n');
  const hits: string[] = [];
  let inFence = false;
  for (const line of lines) {
    // Toggle fenced code blocks (``` or ~~~), whose content is literal.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Mask inline code spans so backtick-wrapped examples don't count.
    const scan = maskInlineCode(line);
    const m = scan.match(tokenRe);
    if (m) hits.push(...m);
  }
  return hits;
}
