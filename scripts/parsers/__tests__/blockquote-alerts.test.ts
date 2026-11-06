import { describe, it, expect } from 'vitest'
import { normalizeBlockquoteAlerts } from '../blockquote-alerts.js'

it('passes through > [!NOTE] unchanged', () => {
  const md = '> [!NOTE]\n> body'
  expect(normalizeBlockquoteAlerts(md)).toBe(md)
})
it('passes through > [!DETAILS] Title unchanged', () => {
  const md = '> [!DETAILS] Why does this work?\n> body'
  expect(normalizeBlockquoteAlerts(md)).toBe(md)
})
it('passes through > [!DETAILS+] Title unchanged (+ sign)', () => {
  const md = '> [!DETAILS+] Open by default\n> body'
  expect(normalizeBlockquoteAlerts(md)).toBe(md)
})
it('leaves plain > blockquote unchanged', () => {
  const md = '> plain blockquote\n> continued'
  expect(normalizeBlockquoteAlerts(md)).toBe(md)
})
it('does not touch > [!NOTE] inside a fenced code block', () => {
  const md = '```\n> [!NOTE]\n> inside fence\n```'
  expect(normalizeBlockquoteAlerts(md)).toBe(md)
})
it('is idempotent on known alert syntax', () => {
  const md = '> [!TROUBLESHOOT] My error\n> body'
  expect(normalizeBlockquoteAlerts(md)).toBe(normalizeBlockquoteAlerts(normalizeBlockquoteAlerts(md)))
})
