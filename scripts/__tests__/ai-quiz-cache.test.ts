import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAiQuizCache,
  saveAiQuizCache,
  hashKey,
  type AiQuizCache,
} from '../lib/ai-quiz-cache.js'

let testCacheDir: string

beforeEach(() => {
  testCacheDir = join(tmpdir(), `ai-quiz-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(testCacheDir, { recursive: true })
})

afterEach(() => {
  rmSync(testCacheDir, { recursive: true, force: true })
})

describe('ai-quiz-cache (#208)', () => {
  it('round-trip: write + read returns equal entry', () => {
    const cache: AiQuizCache = {
      promptVersion: 'v1',
      modelName: 'gpt-test',
      entries: {
        '3': {
          stepHash: 'sha256:abc',
          directive: '[AUTOAUTHOR_3]',
          types: 'mcq-and-text',
          generatedAt: '2026-06-05T00:00:00Z',
          questions: [
            { id: 'validate-3-ai-1', type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a', aiAuthored: true },
          ],
        },
      },
    }
    saveAiQuizCache('test-slug', cache, { cacheDir: testCacheDir })
    const loaded = loadAiQuizCache('test-slug', { cacheDir: testCacheDir })
    expect(loaded).toEqual(cache)
  })

  it('loadAiQuizCache returns empty cache when file missing', () => {
    const loaded = loadAiQuizCache('never-saved', { cacheDir: testCacheDir })
    expect(loaded).toEqual({
      promptVersion: 'v1',
      modelName: '',
      entries: {},
    })
  })

  it('hashKey changes when any input changes', () => {
    const base = { stepBody: 'body', directive: '[AUTOAUTHOR_3]', types: 'mcq-and-text', promptVersion: 'v1', modelName: 'm' }
    const baseHash = hashKey(base)
    expect(hashKey({ ...base, stepBody: 'body2' })).not.toBe(baseHash)
    expect(hashKey({ ...base, directive: '[AUTOAUTHOR_3:mcq]' })).not.toBe(baseHash)
    expect(hashKey({ ...base, types: 'mcq-only' })).not.toBe(baseHash)
    expect(hashKey({ ...base, promptVersion: 'v2' })).not.toBe(baseHash)
    expect(hashKey({ ...base, modelName: 'm2' })).not.toBe(baseHash)
  })

  it('saveAiQuizCache creates the directory if missing', () => {
    const subDir = join(testCacheDir, 'nested', 'path')
    saveAiQuizCache('s', { promptVersion: 'v1', modelName: 'm', entries: {} }, { cacheDir: subDir })
    // Read it back to confirm the dir + file were created.
    const content = readFileSync(join(subDir, 's.ai-quiz-cache.json'), 'utf8')
    expect(JSON.parse(content)).toEqual({ promptVersion: 'v1', modelName: 'm', entries: {} })
  })
})
