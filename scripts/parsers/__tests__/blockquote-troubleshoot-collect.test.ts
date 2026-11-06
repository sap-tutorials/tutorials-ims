import { describe, it, expect } from 'vitest'
import { collectTroubleshootEntries } from '../blockquote-troubleshoot-collect.js'

it('returns empty array when no troubleshoot alerts', () => {
  expect(collectTroubleshootEntries('> [!NOTE]\n> text', 1)).toEqual([])
})

it('collects a single troubleshoot entry with correct anchor', () => {
  const body = '> [!TROUBLESHOOT] Connection refused\n> body text'
  const entries = collectTroubleshootEntries(body, 2)
  expect(entries).toHaveLength(1)
  expect(entries[0].title).toBe('Connection refused')
  expect(entries[0].anchor).toBe('troubleshoot-2-0')
})

it('collects multiple troubleshoot entries in order', () => {
  const body = [
    '> [!TROUBLESHOOT] First error',
    '> body',
    '',
    '> [!TROUBLESHOOT] Second error',
    '> body',
  ].join('\n')
  const entries = collectTroubleshootEntries(body, 3)
  expect(entries).toHaveLength(2)
  expect(entries[0].anchor).toBe('troubleshoot-3-0')
  expect(entries[1].anchor).toBe('troubleshoot-3-1')
  expect(entries[1].title).toBe('Second error')
})

it('does not collect troubleshoot alerts inside a fenced code block', () => {
  const body = '```\n> [!TROUBLESHOOT] Inside fence\n> body\n```'
  expect(collectTroubleshootEntries(body, 1)).toEqual([])
})

it('is case-insensitive on the type word', () => {
  expect(collectTroubleshootEntries('> [!troubleshoot] title\n> body', 1)).toHaveLength(1)
})
