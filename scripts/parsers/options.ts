import { classifyGroup, forceClassify, type OS, type ClassifyResult } from './os-classifier';
import { slugify } from '../../srv/lib/slug-utils.js';
import { classifyLines } from './md-grammar.js';
import { parseStepHeadingAttrs } from './step-attrs.js';
import { classifyGroupToPreset, canonicalForLabel, SYNC_PRESETS } from './sync-presets.js';

interface OptionEntry {
  matchIndex: number
  tabName: string
  content: string
  /** Parsed from the OPTION BEGIN marker, e.g. `sync=runtime` */
  syncKey?: string
}

export type OptionsTarget = 'vitepress' | 'hugo'

/**
 * Thrown when an option group carries conflicting `sync=` keys across its
 * blocks, or when a `sync=` key (or auto-classified key) is neither a
 * built-in preset nor declared in `syncGroups`.
 */
export class OptionSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OptionSyncError'
  }
}

/**
 * Optional override map: { stepSlug: 'os' | 'regular' }.
 * The step slug for each option group is resolved internally by scanning
 * back to the most-recent `### ` H3 heading preceding the group's match
 * index in `content` (compose.ts runs OPTION-block conversion BEFORE step
 * parsing, so we cannot rely on the parsed step list).
 */
export interface ConvertOptions {
  /** Per-step overrides keyed by slugified step heading. */
  osOverrides?: Record<string, 'os' | 'regular'>;
  /**
   * Out-param: function sets `value` to `true` if any OS group is emitted.
   * Caller MUST initialize to `{ value: false }`. The function only writes
   * `true`; it never resets to `false`. This lets a single object accumulate
   * across multiple `convertOptionBlocks` calls within one tutorial.
   */
  hasOsOptionsOut?: { value: boolean };
  /**
   * Out-param: function adds each canonical OS that appears in any emitted OS
   * group to this set, so the caller knows exactly which OSes the tutorial
   * actually supports (used to render only the supported buttons in the OS
   * picker — #2703). Caller MUST initialize to a fresh `Set<OS>()`.
   */
  osListOut?: Set<OS>;
  /**
   * Out-param: function populates with the set of step slugs that were
   * actually resolved by `priorStepSlug` while processing this body. Caller
   * compares against the keys of `osOverrides` to detect typo'd keys that
   * never matched any group. Caller MUST initialize to a fresh `Set<string>()`.
   */
  resolvedStepSlugsOut?: Set<string>;
  /**
   * [synced-tabs] Opt-in auto-classification: `'auto'` → attempt preset
   * classification for every group that has no explicit `sync=` key. Only
   * groups whose labels ALL resolve to the same built-in preset are assigned;
   * unresolvable groups are left as plain option-tabs (no build error).
   */
  syncTabs?: 'auto';
  /**
   * [synced-tabs] Per-step overrides keyed by slugified step heading.
   * `'none'` disables sync for that step's group even if `sync=` is authored
   * or auto-classified. Any other valid key string forces a specific preset or
   * custom key (must still pass undeclared-key validation).
   */
  syncOverrides?: Record<string, string>;
  /**
   * [synced-tabs] Custom sync-group declarations for tutorial-specific keys
   * that are not built-in presets. Provides the known values so the parser can
   * compute canonical syncValue for each tab and accept the key without error.
   */
  syncGroups?: Record<string, {
    label: string
    values: string[]
    aliases?: Record<string, string[]>
    default?: string
  }>;
  /**
   * [synced-tabs] Out-param: populated with every sync key actually used
   * (emitted) in any option-tabs group during this conversion. Caller MUST
   * initialize to a fresh `Set<string>()`.
   */
  syncKeysUsedOut?: Set<string>;
}

/** Find the slugified ### heading immediately preceding `index` in `content`.
 *  Fenced code blocks are honored — an `### ` line quoted inside a code fence
 *  is treated as literal content, not as a step heading. (Tutorials that
 *  document authoring syntax embed H3s inside fences; see the matching
 *  grammar-awareness in v2.ts and branches.ts via md-grammar.ts.) */
function priorStepSlug(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const classes = classifyLines(before);
  const lines = before.split('\n');
  let last: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (classes[i]?.kind === 'heading' && classes[i].level === 3) {
      const rawTitle = lines[i].replace(/^###\s+/, '').replace(/\s*$/, '');
      // [tutorial-step-pacing] Strip the same `{time=… optional}` attribute
      // block v2.ts strips before computing the step slug, so an osOverrides
      // key keyed on a step heading using the new syntax still resolves
      // (D1 — slug stability is independent of the attribute block).
      last = parseStepHeadingAttrs(rawTitle).title;
    }
  }
  return last ? slugify(last) : undefined;
}

/** Strip the common leading indentation shared by all non-blank lines of
 *  `text`. When an OPTION block is authored inside a numbered substep its
 *  body is indented (typically 4 spaces); that indent must be removed before
 *  the body is handed to the shortcode, otherwise Goldmark treats an indented
 *  ```fence``` as a literal indented-code block (showing the backticks) and
 *  mis-nests images/notes. Dedenting to column 0 lets os-panel.html's
 *  `{{ .Inner | markdownify }}` parse the body as normal markdown (#2703).
 *
 *  IMPORTANT: callers must NOT pre-`.trim()` the text. A whole-string trim
 *  de-indents only the FIRST line (it strips leading whitespace of the string,
 *  not of each line), which makes the min-indent scan below see 0 and turn the
 *  whole dedent into a no-op — the exact regression behind the
 *  hana-clients-install#step-2 report, where every body line except the first
 *  stayed 4-space indented. Pass the raw captured body; this function trims the
 *  surrounding blank lines itself, after dedenting. */
function dedentBlock(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.match(/^[ \t]*/);
    min = Math.min(min, m ? m[0].length : 0);
  }
  const dedented = (!isFinite(min) || min === 0)
    ? lines
    : lines.map(line => (line.trim() === '' ? line : line.slice(min)));
  // Drop leading/trailing all-blank lines so the shortcode body is tight,
  // without disturbing the now-uniform internal indentation.
  while (dedented.length && dedented[0].trim() === '') dedented.shift();
  while (dedented.length && dedented[dedented.length - 1].trim() === '') dedented.pop();
  return dedented.join('\n');
}

/** Re-indent only the shortcode WRAPPER lines of a built replacement block by
 *  `indent`, leaving every body line at its current (column-0) position.
 *
 *  Approach A for #2820: the OPTION shortcode must stay inside the surrounding
 *  numbered <li>, so its wrapper lines carry the substep's indentation — but the
 *  panel body must stay at column 0 so os-panel.html's `{{ .Inner | markdownify }}`
 *  parses it as markdown rather than a literal indented-code block (#2703).
 *
 *  A "wrapper line" is a Hugo shortcode delimiter (`{{< … >}}` / `{{% … %}}`) or
 *  a VitePress `<OptionTabs>` / `<template>` tag — i.e. the structural lines this
 *  module itself emits around the (already dedented) body. Blank lines are left
 *  untouched so no trailing whitespace is introduced. */
function indentWrapperLines(block: string, indent: string): string {
  const wrapper = /^(\{\{[<%]\s*\/?\s*(os-options|os-panel|option-tabs|tab)\b|<\/?OptionTabs|<\/?template\b)/;
  return block
    .split('\n')
    .map(line => (wrapper.test(line) ? indent + line : line))
    .join('\n');
}

/** Built-in preset key names. Used for undeclared-key validation. */
const BUILT_IN_PRESET_KEYS = Object.keys(SYNC_PRESETS)

/**
 * Resolve the sync key that applies to an option group, given:
 * - explicit `sync=` keys from the group's OPTION BEGIN markers
 * - per-step `syncOverrides` from frontmatter
 * - auto-classification via `syncTabs: 'auto'`
 *
 * Returns the resolved key string, `'none'` to suppress sync, or `undefined`
 * when no sync applies.
 *
 * Throws `OptionSyncError` for:
 * - conflicting explicit keys within the same group
 * - an undeclared key (not a built-in preset AND not in `syncGroups`)
 */
function resolveGroupSyncKey(
  group: OptionEntry[],
  stepSlug: string | undefined,
  opts: ConvertOptions,
): string | undefined {
  // 1. Collect explicit sync= keys from the group (only first block is required
  //    to carry it; others may omit it, but MUST NOT carry a different one).
  const explicitKeys = group.map(e => e.syncKey).filter((k): k is string => !!k)
  if (explicitKeys.length > 0) {
    const uniqueKeys = [...new Set(explicitKeys)]
    if (uniqueKeys.length > 1) {
      throw new OptionSyncError(
        `[options] conflicting sync= keys in one option group: ${uniqueKeys.join(', ')}. ` +
        `Only the first block needs sync=; other blocks must omit it or use the same key.`
      )
    }
  }
  const explicitKey = explicitKeys[0] // first explicit key if any

  // 2. Apply syncOverrides for this step
  const stepOverride = stepSlug ? opts.syncOverrides?.[stepSlug] : undefined
  if (stepOverride === 'none') return undefined // disabled for this step
  // A stepOverride value that isn't 'none' forces a specific key
  const forcedKey = stepOverride && stepOverride !== 'none' ? stepOverride : undefined

  // 3. Determine the effective key
  // Priority: explicit > forced > auto
  let effectiveKey = forcedKey ?? explicitKey

  if (!effectiveKey && opts.syncTabs === 'auto') {
    // Auto-classify: attempt preset classification
    const labels = group.map(e => e.tabName)
    const classified = classifyGroupToPreset(labels)
    if (classified?.key) effectiveKey = classified.key
  }

  if (!effectiveKey) return undefined

  // 4. Validate: key must be a built-in preset or declared in syncGroups
  const isBuiltIn = BUILT_IN_PRESET_KEYS.includes(effectiveKey)
  const isDeclared = !!opts.syncGroups?.[effectiveKey]
  if (!isBuiltIn && !isDeclared) {
    throw new OptionSyncError(
      `[options] sync key "${effectiveKey}" is not a built-in preset (${BUILT_IN_PRESET_KEYS.join(', ')}) ` +
      `and is not declared in syncGroups. Declare it in frontmatter syncGroups or use a built-in preset key.`
    )
  }

  return effectiveKey
}

/**
 * Compute the canonical syncValue for a tab label given a resolved sync key.
 * For built-in presets: use canonicalForLabel.
 * For custom syncGroups: use the label as-is (pass through).
 */
function computeSyncValue(
  tabName: string,
  syncKey: string,
  opts: ConvertOptions,
): string {
  // Try built-in preset first
  const preset = canonicalForLabel(syncKey, tabName)
  if (preset !== null) return preset

  // Custom syncGroups: use tab name as canonical (author defines values; no aliasing in parser)
  return tabName
}

export function convertOptionBlocks(
  content: string,
  target: OptionsTarget = 'vitepress',
  opts: ConvertOptions = {}
): string {
  // Extended regex: optional ` sync=<key>` after the label, before the closing `]`
  // Original:  /\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g
  // Extended:  captures optional `sync=<key>` group
  const optionPattern = /\[OPTION BEGIN \[([^\]]+)\](?:\s+sync=([a-z][a-z0-9-]*))?\]\s*\n([\s\S]*?)\[OPTION END\]/g

  const matches = [...content.matchAll(optionPattern)]
  if (matches.length === 0) return content

  const groups: OptionEntry[][] = []
  let currentGroup: OptionEntry[] = []

  for (let i = 0; i < matches.length; i++) {
    const entry: OptionEntry = {
      matchIndex: i,
      tabName: matches[i][1],
      // Extended: capture[2] = sync key (optional), capture[3] = body
      syncKey: matches[i][2] || undefined,
      // Keep the RAW captured body (no .trim()); dedentBlock needs every line's
      // real indentation to compute the common prefix. Pre-trimming de-indents
      // only line 1 and defeats the dedent (#2703 follow-up).
      content: matches[i][3].replace(/\s+$/, ''),
    }
    if (currentGroup.length > 0) {
      const prevMatch = matches[i - 1]
      const prevEnd = prevMatch.index! + prevMatch[0].length
      const gap = content.slice(prevEnd, matches[i].index!).trim()
      if (gap.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
    }
    currentGroup.push(entry)
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  let result = content
  for (const group of groups.reverse()) {
    const firstMatch = matches[group[0].matchIndex]
    const lastMatch = matches[group[group.length - 1].matchIndex]
    const start = firstMatch.index!
    const end = lastMatch.index! + lastMatch[0].length

    // Splice from the START of the first marker's line. We CAPTURE this line's
    // leading indentation (present when the OPTION block is nested inside a
    // numbered substep) and re-apply it to the shortcode WRAPPER lines only.
    //
    // #2820: emitting the wrappers flush-left (the old behaviour) closed the
    // surrounding markdown list, so any figure inside an os-panel — or trailing
    // the group in the same substep — rendered as a top-level <figure>, a
    // SIBLING of the list rather than a child of the <li>, losing its list
    // indentation. Keeping the wrapper lines indented to the substep keeps the
    // shortcode INSIDE the <li> so the list never closes and substep numbering
    // is continuous (no `<ol start="N">` reopen needed).
    //
    // The panel BODY lines, however, stay at COLUMN 0: os-panel.html runs
    // `{{ .Inner | markdownify }}`, and a 4-space-indented body is parsed by
    // that second Goldmark pass as a literal indented-code block (showing the
    // backticks / raw image markdown) — the #2703 failure mode. So we indent
    // the wrappers but never the body. (Verified against a real Hugo render:
    // figure ancestor chain becomes div.os-panel < div.os-options < li < ol.)
    const lineStart = result.lastIndexOf('\n', start - 1) + 1;
    const indentMatch = result.slice(lineStart, start).match(/^[ \t]*/);
    const blockIndent = indentMatch ? indentMatch[0] : '';

    let replacement: string

    if (target === 'hugo') {
      const labels = group.map(g => g.tabName);
      const stepSlug = priorStepSlug(content, firstMatch.index!);
      if (stepSlug && opts.resolvedStepSlugsOut) {
        opts.resolvedStepSlugsOut.add(stepSlug);
      }
      const override = stepSlug ? opts.osOverrides?.[stepSlug] : undefined;

      const decision: ClassifyResult =
        override === 'regular' ? { kind: 'regular', assignments: new Map() } :
        override === 'os'      ? forceClassify(labels) :
                                  classifyGroup(labels);

      if (override === 'os' && decision.kind === 'regular' && stepSlug) {
        console.warn(
          `[options] osOverrides: 'os' on step "${stepSlug}" fell back to regular — ` +
          `no classifier rule matched: ${group.map(e => e.tabName).join(', ')}`
        );
      }

      if (decision.kind === 'os') {
        if (opts.hasOsOptionsOut) opts.hasOsOptionsOut.value = true;
        if (opts.osListOut) {
          for (const oses of decision.assignments.values()) {
            for (const os of oses) opts.osListOut.add(os);
          }
        }
        // Emit one os-panel per CANONICAL OS — combined labels duplicate content.
        const panels: string[] = [];
        for (const entry of group) {
          const oses = decision.assignments.get(entry.tabName)!;
          for (const os of oses) {
            panels.push(`{{< os-panel os="${os}" >}}\n\n${dedentBlock(entry.content)}\n\n{{< /os-panel >}}`);
          }
        }
        replacement = `{{< os-options >}}\n${panels.join('\n')}\n{{< /os-options >}}`;
      } else {
        // Resolve sync key for this group (throws OptionSyncError on conflicts/undeclared keys)
        const syncKey = resolveGroupSyncKey(group, stepSlug, opts)

        // Track used keys
        if (syncKey && opts.syncKeysUsedOut) {
          opts.syncKeysUsedOut.add(syncKey)
        }

        const tabNames = group.map(b => b.tabName).join(',')
        const syncTabsAttr = syncKey ? ` sync="${syncKey}"` : ''
        const tabs = group.map((b, i) => {
          const syncValueAttr = syncKey
            ? ` syncValue="${computeSyncValue(b.tabName, syncKey, opts)}"`
            : ''
          return `{{% tab index="${i}" name="${b.tabName}"${syncValueAttr} %}}\n\n${dedentBlock(b.content)}\n\n{{% /tab %}}`
        }).join('\n')
        replacement = `{{% option-tabs tabs="${tabNames}"${syncTabsAttr} %}}\n${tabs}\n{{% /option-tabs %}}`;
      }
    } else {
      // VitePress branch unchanged.
      const tabNames = group.map(b => `'${b.tabName}'`).join(',')
      const slots = group.map((b, i) =>
        `<template #tab-${i}>\n\n${dedentBlock(b.content)}\n\n</template>`
      ).join('\n')
      replacement = `<OptionTabs :tabs="[${tabNames}]">\n${slots}\n</OptionTabs>`
    }

    // Re-apply the substep's indentation to the shortcode WRAPPER lines only
    // (the `{{< … >}}` / `{{% … %}}` lines), leaving the panel body at column 0.
    // This keeps the whole shortcode inside the surrounding <li> (#2820) while
    // the column-0 body still parses as markdown under os-panel.html's
    // `{{ .Inner | markdownify }}` (#2703). A column-0 OPTION block (blockIndent
    // === '') is unaffected — it stays flush-left as before.
    if (blockIndent) {
      replacement = indentWrapperLines(replacement, blockIndent);
    }

    result = result.slice(0, lineStart) + replacement + result.slice(end)

    // Bug B (#2820): content that trails the OPTION group but still belongs to
    // the same numbered substep (e.g. "Set the install directory…", an image, a
    // `> [!TIP]`) is authored indented 4 spaces. A Hugo shortcode that emits a
    // block-level <div> CLOSES the surrounding tight list regardless of the
    // wrapper indent (verified against production-pinned Hugo 0.147.7 — the
    // os-options/os-panel div interrupts list continuation). Once the list has
    // closed, Goldmark measures the still-4-space-indented tail from column 0,
    // where the >=4-space rule turns it into a literal indented-code block — the
    // exact raw-markdown leak of #2820. So dedent the tail to column 0 (up to the
    // next list marker / shortcode / de-indented line) so it renders as sibling
    // markdown; the author's own `N.` ordinal then reopens the list as
    // <ol start="N"> and numbering continues.
    //
    // Commit 19db8d027 DELETED this loop on the false premise that "with the
    // wrappers indented the list never closes" — the Hugo renders disprove that;
    // the list always closes, so the dedent is mandatory. See
    // docs/superpowers/specs/2026-10-20-option-block-rendering-design.md.
    const tailStart = lineStart + replacement.length
    const after = result.slice(tailStart)
    const tailLines = after.split('\n')
    const dedentedTail: string[] = []
    let stopped = false
    for (const line of tailLines) {
      if (stopped) { dedentedTail.push(line); continue }
      if (line.trim() === '') { dedentedTail.push(line); continue }
      // A line indented >= 4 spaces is trailing substep content → dedent it.
      if (/^ {4}/.test(line)) { dedentedTail.push(line.slice(4)); continue }
      // A tab-indented line → strip one leading tab.
      if (/^\t/.test(line)) { dedentedTail.push(line.replace(/^\t/, '')); continue }
      // First line at column 0 (next list marker, shortcode, heading, or the
      // list's end) — stop; everything from here is outside this substep's tail.
      stopped = true
      dedentedTail.push(line)
    }
    result = result.slice(0, tailStart) + dedentedTail.join('\n')
  }

  return result
}
