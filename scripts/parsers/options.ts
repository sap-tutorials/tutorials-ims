import { classifyGroup, forceClassify, type OS, type ClassifyResult } from './os-classifier';

interface OptionEntry {
  matchIndex: number
  tabName: string
  content: string
}

export type OptionsTarget = 'vitepress' | 'hugo'

/**
 * Optional override map: { stepSlug: 'os' | 'regular' }.
 * Caller (fetch-tutorials.ts) is responsible for slugifying the step heading
 * and passing the matching key when present. Task 3 wires this through.
 */
export interface ConvertOptions {
  /** Step slug for the current step being processed. */
  stepSlug?: string;
  /** Per-step overrides keyed by step slug. */
  osOverrides?: Record<string, 'os' | 'regular'>;
  /**
   * Out-param: function sets `value` to `true` if any OS group is emitted.
   * Caller MUST initialize to `{ value: false }`. The function only writes
   * `true`; it never resets to `false`. This lets a single object accumulate
   * across multiple `convertOptionBlocks` calls within one tutorial.
   */
  hasOsOptionsOut?: { value: boolean };
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

    let replacement: string

    if (target === 'hugo') {
      const labels = group.map(g => g.tabName);
      const override = opts.stepSlug ? opts.osOverrides?.[opts.stepSlug] : undefined;

      const decision: ClassifyResult =
        override === 'regular' ? { kind: 'regular', assignments: new Map() } :
        override === 'os'      ? forceClassify(labels) :
                                  classifyGroup(labels);

      if (override === 'os' && decision.kind === 'regular' && opts.stepSlug) {
        console.warn(
          `[options] osOverrides: 'os' on step "${opts.stepSlug}" fell back to regular — ` +
          `no classifier rule matched: ${group.map(e => e.tabName).join(', ')}`
        );
      }

      if (decision.kind === 'os') {
        if (opts.hasOsOptionsOut) opts.hasOsOptionsOut.value = true;
        // Emit one os-panel per CANONICAL OS — combined labels duplicate content.
        const panels: string[] = [];
        for (const entry of group) {
          const oses = decision.assignments.get(entry.tabName)!;
          for (const os of oses) {
            panels.push(`{{< os-panel os="${os}" >}}\n\n${entry.content}\n\n{{< /os-panel >}}`);
          }
        }
        replacement = `{{< os-options >}}\n${panels.join('\n')}\n{{< /os-options >}}`;
      } else {
        // Existing legacy path — option-tabs shortcode.
        const tabNames = group.map(b => b.tabName).join(',')
        const tabs = group.map((b, i) =>
          `{{% tab index="${i}" name="${b.tabName}" %}}\n\n${b.content}\n\n{{% /tab %}}`
        ).join('\n')
        replacement = `{{% option-tabs tabs="${tabNames}" %}}\n${tabs}\n{{% /option-tabs %}}`;
      }
    } else {
      // VitePress branch unchanged.
      const tabNames = group.map(b => `'${b.tabName}'`).join(',')
      const slots = group.map((b, i) =>
        `<template #tab-${i}>\n\n${b.content}\n\n</template>`
      ).join('\n')
      replacement = `<OptionTabs :tabs="[${tabNames}]">\n${slots}\n</OptionTabs>`
    }

    result = result.slice(0, start) + replacement + result.slice(end)
  }

  return result
}
