import { describe, it, expect, beforeEach } from 'vitest'
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAvatarUrl, normalizeEmail, pinCreatedAt } from '../github.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', '..', '.tutorial-cache')

describe('drift-resistance helpers — contributor metadata normalization', () => {
  describe('normalizeAvatarUrl', () => {
    it('strips the volatile ?v= version query', () => {
      // GitHub avatar URLs format: https://avatars.githubusercontent.com/u/<id>?v=<n>
      // The ?v=<n> increments when the user updates their profile picture.
      expect(normalizeAvatarUrl('https://avatars.githubusercontent.com/u/12345?v=4'))
        .toBe('https://avatars.githubusercontent.com/u/12345')
    })

    it('preserves URLs that have no query string', () => {
      expect(normalizeAvatarUrl('https://avatars.githubusercontent.com/u/12345'))
        .toBe('https://avatars.githubusercontent.com/u/12345')
    })

    it('strips ANY query, not just v=', () => {
      // Future-proof: GitHub may add other volatile params (size, etc.)
      expect(normalizeAvatarUrl('https://avatars.githubusercontent.com/u/12345?s=80&v=4'))
        .toBe('https://avatars.githubusercontent.com/u/12345')
    })

    it('returns empty string for empty input', () => {
      expect(normalizeAvatarUrl('')).toBe('')
    })
  })

  describe('normalizeEmail', () => {
    it('synthesizes a stable noreply form when given a real email', () => {
      // The author may have email-privacy enabled OR disabled at any time.
      // We always emit the login-form noreply so frontmatter is invariant.
      expect(normalizeEmail('jane.doe@example.com', 'janedoe'))
        .toBe('janedoe@users.noreply.github.com')
    })

    it('preserves an existing noreply form (login variant)', () => {
      expect(normalizeEmail('janedoe@users.noreply.github.com', 'janedoe'))
        .toBe('janedoe@users.noreply.github.com')
    })

    it('preserves an existing noreply form (ID+login variant)', () => {
      // Some users have email like "12345+janedoe@users.noreply.github.com"
      // (the form auto-set by GitHub when email-privacy is enabled). We
      // keep it as-is so the embedded user ID is preserved for downstream
      // consumers that want it.
      expect(normalizeEmail('12345+janedoe@users.noreply.github.com', 'janedoe'))
        .toBe('12345+janedoe@users.noreply.github.com')
    })

    it('passes through unchanged when no login is provided', () => {
      // Edge case: we can't synthesize without a login. The author of the
      // commit might be anonymous (no GitHub account). Best-effort: keep
      // whatever we have.
      expect(normalizeEmail('jane.doe@example.com', '')).toBe('jane.doe@example.com')
    })

    it('returns empty for empty email + empty login', () => {
      expect(normalizeEmail('', '')).toBe('')
    })

    it('is case-insensitive on the noreply suffix check', () => {
      // GitHub serves the suffix lowercase but commit data might be
      // captured before normalization.
      expect(normalizeEmail('JaneDoe@Users.NoReply.GitHub.Com', 'janedoe'))
        .toBe('JaneDoe@Users.NoReply.GitHub.Com')
    })
  })

  describe('pinCreatedAt', () => {
    const TEST_SLUG = '__drift-test-slug__'
    const CACHE_FILE = join(CACHE_DIR, `${TEST_SLUG}.created`)

    beforeEach(() => {
      // Clean state for each test. Best-effort: in CI the cache dir
      // may not exist on first run, which is fine.
      try {
        if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE)
      } catch {
        // ignore
      }
    })

    it('returns the observed value on first call and writes it to cache', () => {
      const result = pinCreatedAt(TEST_SLUG, '2023-01-15T10:30:00Z')
      expect(result).toBe('2023-01-15T10:30:00Z')
      expect(existsSync(CACHE_FILE)).toBe(true)
      expect(readFileSync(CACHE_FILE, 'utf-8').trim()).toBe('2023-01-15T10:30:00Z')
    })

    it('returns the cached value on subsequent calls (frozen)', () => {
      // First call pins the value.
      pinCreatedAt(TEST_SLUG, '2023-01-15T10:30:00Z')

      // Sliding-window-shifted later observation. Without pinning, this
      // would be the new "earliest of last 30 commits". With pinning,
      // we keep the original.
      const result = pinCreatedAt(TEST_SLUG, '2024-06-21T15:45:00Z')
      expect(result).toBe('2023-01-15T10:30:00Z')
    })

    it('respects a pre-existing cache file even if observed is empty', () => {
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      writeFileSync(CACHE_FILE, '2020-03-04T00:00:00Z', 'utf-8')

      const result = pinCreatedAt(TEST_SLUG, '')
      expect(result).toBe('')
      // Empty observed shouldn't fall through to use the cache — it
      // returns '' so callers can distinguish "no data" from "pinned".
      // The cache file is still there for next time though.
      expect(existsSync(CACHE_FILE)).toBe(true)
    })

    it('returns empty string when both observed and cache are empty', () => {
      const result = pinCreatedAt(TEST_SLUG, '')
      expect(result).toBe('')
    })

    it('ignores a cache file with only whitespace', () => {
      // Edge case: a previous write got truncated mid-flight. We treat
      // whitespace-only cache as missing.
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      writeFileSync(CACHE_FILE, '   \n  \n', 'utf-8')

      const result = pinCreatedAt(TEST_SLUG, '2024-01-01T00:00:00Z')
      expect(result).toBe('2024-01-01T00:00:00Z')
      // And we write the new observed value so subsequent runs converge.
      expect(readFileSync(CACHE_FILE, 'utf-8').trim()).toBe('2024-01-01T00:00:00Z')
    })
  })
})
