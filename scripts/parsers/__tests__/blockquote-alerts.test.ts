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
it('throws on > [!DETAILS] with no title text', () => {
  expect(() => normalizeBlockquoteAlerts('> [!DETAILS]\n> body', { slug: 'test-slug', line: 1 }))
    .toThrow(/\[!DETAILS\].*title.*required/i)
})
it('passes > [!DETAILS+] with a title', () => {
  expect(() => normalizeBlockquoteAlerts('> [!DETAILS+] Title here\n> body')).not.toThrow()
})
it('throws on > [!DETAILS+] with no title', () => {
  expect(() => normalizeBlockquoteAlerts('> [!DETAILS+]\n> body', { slug: 'test-slug', line: 1 }))
    .toThrow(/\[!DETAILS\].*title.*required/i)
})
it('error message includes slug and line number', () => {
  expect(() => normalizeBlockquoteAlerts('> [!DETAILS]\n> body', { slug: 'my-tutorial', line: 0 }))
    .toThrow(/my-tutorial/)
})
it('does not throw on > [!DETAILS] inside a fenced code block', () => {
  const md = '```\n> [!DETAILS]\n> inside fence\n```'
  expect(() => normalizeBlockquoteAlerts(md)).not.toThrow()
})
