import { classifyGroup, forceClassify, type OS, type ClassifyResult } from './os-classifier';
import { slugify } from '../../srv/lib/slug-utils.js';
import { createFenceTracker } from './fence-tracker.js';

interface OptionEntry {
  matchIndex: number
  tabName: string
  content: string
}

export type OptionsTarget = 'vitepress' | 'hugo'

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
}

/** Find the slugified ### heading immediately preceding `index` in `content`.
 *  Fenced code blocks are honored — an `### ` line quoted inside a code fence
 *  is treated as literal content, not as a step heading. (Tutorials that
 *  document authoring syntax embed H3s inside fences; see the matching
 *  fence-awareness in v2.ts and branches.ts via fence-tracker.ts.) */
function priorStepSlug(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const fence = createFenceTracker();
  let last: string | undefined;
  for (const line of before.split('\n')) {
    if (fence(line)) continue;
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) last = m[1];
  }
  return last ? slugify(last) : undefined;
}

/** Strip the common leading indentation shared by all non-blank lines of
 *  `text`. When an OPTION block is authored inside a numbered substep its
 *  body is indented (typically 4 spaces); that indent must be removed before
 *  the body is handed to the shortcode, otherwise Goldmark treats an indented
 *  ```fence``` as a literal indented-code block (showing the backticks) and
 *  mis-nests images/notes. Dedenting to column 0 lets os-panel.html's
 *  `{{ .Inner | markdownify }}` parse the body as normal markdown (#2703). */
function dedentBlock(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.match(/^[ \t]*/);
    min = Math.min(min, m ? m[0].length : 0);
  }
  if (!isFinite(min) || min === 0) return text;
  return lines.map(line => (line.trim() === '' ? line : line.slice(min))).join('\n');
}

export function convertOptionBlocks(
  content: string,
  target: OptionsTarget = 'vitepress',
  opts: ConvertOptions = {}
): string {
  const optionPattern = /\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g

  const matches = [...content.matchAll(optionPattern)]
  if (matches.length === 0) return content

  const groups: OptionEntry[][] = []
  let currentGroup: OptionEntry[] = []

  for (let i = 0; i < matches.length; i++) {
    const entry: OptionEntry = {
      matchIndex: i,
      tabName: matches[i][1],
      content: matches[i][2].trim(),
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

    // Splice from the START of the first marker's line so any leading
    // indentation on that line (present when the OPTION block is nested inside
    // a numbered substep) is dropped. The replacement is emitted flush-left:
    // the surrounding markdown list closes, but Goldmark re-opens it with
    // `<ol start="N">` after the block, so substep numbering is preserved,
    // while os-panel.html's `{{ .Inner | markdownify }}` renders the dedented
    // body (code fences / images / notes) as proper markdown (#2703).
    const lineStart = result.lastIndexOf('\n', start - 1) + 1;

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
        // Existing legacy path — option-tabs shortcode.
        const tabNames = group.map(b => b.tabName).join(',')
        const tabs = group.map((b, i) =>
          `{{% tab index="${i}" name="${b.tabName}" %}}\n\n${dedentBlock(b.content)}\n\n{{% /tab %}}`
        ).join('\n')
        replacement = `{{% option-tabs tabs="${tabNames}" %}}\n${tabs}\n{{% /option-tabs %}}`;
      }
    } else {
      // VitePress branch unchanged.
      const tabNames = group.map(b => `'${b.tabName}'`).join(',')
      const slots = group.map((b, i) =>
        `<template #tab-${i}>\n\n${dedentBlock(b.content)}\n\n</template>`
      ).join('\n')
      replacement = `<OptionTabs :tabs="[${tabNames}]">\n${slots}\n</OptionTabs>`
    }

    result = result.slice(0, lineStart) + replacement + result.slice(end)
  }

  return result
}
