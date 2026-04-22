interface OptionEntry {
  matchIndex: number
  tabName: string
  content: string
}

export function convertOptionBlocks(content: string): string {
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
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  let result = content
  for (const group of groups.reverse()) {
    const firstMatch = matches[group[0].matchIndex]
    const lastMatch = matches[group[group.length - 1].matchIndex]
    const start = firstMatch.index!
    const end = lastMatch.index! + lastMatch[0].length

    const tabNames = group.map(b => `'${b.tabName}'`).join(',')
    const slots = group.map((b, i) =>
      `<template #tab-${i}>\n\n${b.content}\n\n</template>`
    ).join('\n')

    const replacement = `<OptionTabs :tabs="[${tabNames}]">\n${slots}\n</OptionTabs>`
    result = result.slice(0, start) + replacement + result.slice(end)
  }

  return result
}
