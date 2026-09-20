import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadChallengeSpecCache,
  saveChallengeSpecCache,
  hashKey,
  type ChallengeSpecCache,
} from '../lib/challenge-spec-cache.js'

let testCacheDir: string

beforeEach(() => {
  testCacheDir = join(tmpdir(), `challenge-spec-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(testCacheDir, { recursive: true })
})

afterEach(() => {
  rmSync(testCacheDir, { recursive: true, force: true })
})

const sampleEntry = () => ({
  stepHash: 'deadbeef',
  generatedAt: '2026-09-20T00:00:00Z',
  spec: { nodes: [{ id: 'challenge-2-0', type: 'freeText', prompt: 'Explain.', aiGraded: true }] },
  referenceAnswers: [{ nodeId: 'challenge-2-0', reference: 'The answer.' }],
})

describe('challenge-spec-cache (#2441)', () => {
  it('round-trip: write + read returns equal cache', () => {
    const cache: ChallengeSpecCache = {
      promptVersion: 'v1',
      modelName: 'test-model',
      entries: { '2': sampleEntry() },
    }
    saveChallengeSpecCache('test-slug', cache, { cacheDir: testCacheDir })
    const loaded = loadChallengeSpecCache('test-slug', { cacheDir: testCacheDir })
    expect(loaded).toEqual(cache)
  })

  it('returns an empty cache when the file is missing', () => {
    const loaded = loadChallengeSpecCache('never-written', { cacheDir: testCacheDir })
    expect(loaded).toEqual({ promptVersion: 'v1', modelName: '', entries: {} })
  })

  it('slug is lowercased in the cache filename', () => {
    saveChallengeSpecCache('Mixed-CASE', { promptVersion: 'v1', modelName: 'm', entries: {} }, { cacheDir: testCacheDir })
    expect(existsSync(join(testCacheDir, 'mixed-case.challenge-spec-cache.json'))).toBe(true)
  })

  describe('hashKey', () => {
    it('is stable for identical inputs', () => {
      const a = hashKey({ stepBody: 'body', promptVersion: 'v1', modelName: 'm' })
      const b = hashKey({ stepBody: 'body', promptVersion: 'v1', modelName: 'm' })
      expect(a).toBe(b)
    })

    it('changes when the step body changes (→ regenerate)', () => {
      const a = hashKey({ stepBody: 'body one', promptVersion: 'v1', modelName: 'm' })
      const b = hashKey({ stepBody: 'body two', promptVersion: 'v1', modelName: 'm' })
      expect(a).not.toBe(b)
    })

    it('changes when the prompt version bumps (→ invalidate all)', () => {
      const a = hashKey({ stepBody: 'body', promptVersion: 'v1', modelName: 'm' })
      const b = hashKey({ stepBody: 'body', promptVersion: 'v2', modelName: 'm' })
      expect(a).not.toBe(b)
    })

    it('changes when the model changes (→ regenerate)', () => {
      const a = hashKey({ stepBody: 'body', promptVersion: 'v1', modelName: 'model-a' })
      const b = hashKey({ stepBody: 'body', promptVersion: 'v1', modelName: 'model-b' })
      expect(a).not.toBe(b)
    })

    it('uses a NUL separator so field boundaries cannot collide', () => {
      // 'a' + 'bc' vs 'ab' + 'c' would collide under naive concatenation.
      const a = hashKey({ stepBody: 'a', promptVersion: 'bc', modelName: 'm' })
      const b = hashKey({ stepBody: 'ab', promptVersion: 'c', modelName: 'm' })
      expect(a).not.toBe(b)
    })
  })
})
