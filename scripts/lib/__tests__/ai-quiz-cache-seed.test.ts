// scripts/lib/__tests__/ai-quiz-cache-seed.test.ts
import { describe, it, expect } from 'vitest'
import { seedAiQuizCache, autoDetectPrimaryCacheDir, AI_QUIZ_CACHE_SUFFIX, type SeedFs } from '../ai-quiz-cache-seed.js'

/**
 * In-memory fs fake. Dirs are keys in `dirs`; each maps to a Set of file
 * basenames. copyFileSync adds the basename to the dest dir.
 */
function fakeFs(initial: Record<string, string[]>): { fs: SeedFs; dirs: Record<string, Set<string>> } {
  const dirs: Record<string, Set<string>> = {}
  for (const [dir, files] of Object.entries(initial)) dirs[dir] = new Set(files)
  const base = (p: string) => p.split(/[\\/]/).pop() as string
  const norm = (p: string) => p.replace(/\\/g, '/')
  // Resolve a file path to its owning dir by longest known-dir-key prefix,
  // comparing on normalized separators (node:path.join yields '\' on win32).
  const dirOf = (p: string) => {
    const np = norm(p)
    const candidates = Object.keys(dirs)
      .filter(d => np.startsWith(norm(d) + '/'))
      .sort((a, b) => b.length - a.length)
    return candidates[0] ?? p.slice(0, p.length - base(p).length).replace(/[\\/]+$/, '')
  }
  const fs: SeedFs = {
    existsSync: (p) => p in dirs,
    mkdirSync: (p) => { if (!(p in dirs)) dirs[p] = new Set() },
    readdirSync: (p) => [...(dirs[p] ?? [])],
    copyFileSync: (_src, dest) => {
      const d = dirOf(dest)
      if (!(d in dirs)) dirs[d] = new Set()
      dirs[d].add(base(dest))
    },
  }
  return { fs, dirs }
}

const QUIZ = (slug: string) => `${slug}${AI_QUIZ_CACHE_SUFFIX}`

describe('seedAiQuizCache', () => {
  it('reports warm and does NOT seed when the active cache already has entries', () => {
    const { fs } = fakeFs({
      '/active': [QUIZ('a'), QUIZ('b')],
      '/primary': [QUIZ('a'), QUIZ('b'), QUIZ('c')],
    })
    const r = seedAiQuizCache('/active', '/primary', { fs })
    expect(r.seeded).toBe(0)
    expect(r.cold).toBe(false)
    expect(r.warmAfter).toBe(2)
    expect(r.message).toContain('warm')
  })

  it('seeds from the primary tree when the active cache is cold', () => {
    const { fs, dirs } = fakeFs({
      '/active': [],
      '/primary': [QUIZ('a'), QUIZ('b'), QUIZ('c')],
    })
    const r = seedAiQuizCache('/active', '/primary', { fs })
    expect(r.seeded).toBe(3)
    expect(r.warmAfter).toBe(3)
    expect(r.cold).toBe(false)
    expect([...dirs['/active']].sort()).toEqual([QUIZ('a'), QUIZ('b'), QUIZ('c')])
    expect(r.message).toContain('seeded 3')
  })

  it('does not clobber an entry already present in the active cache', () => {
    const { fs, dirs } = fakeFs({
      '/active': [QUIZ('a')],
      '/primary': [QUIZ('a'), QUIZ('b')],
    })
    // coldThreshold 1 so a single-entry active cache still triggers seeding of the rest.
    const r = seedAiQuizCache('/active', '/primary', { fs, coldThreshold: 1 })
    expect(r.seeded).toBe(1) // only b copied; a left untouched
    expect([...dirs['/active']].sort()).toEqual([QUIZ('a'), QUIZ('b')])
  })

  it('warns LOUDLY (cold=true) when cold and no primary cache dir is given', () => {
    const { fs } = fakeFs({ '/active': [] })
    const r = seedAiQuizCache('/active', undefined, { fs })
    expect(r.seeded).toBe(0)
    expect(r.cold).toBe(true)
    expect(r.message).toContain('COLD CACHE')
    expect(r.message).toContain('AI_QUIZ_CACHE_SEED_DIR')
  })

  it('warns LOUDLY when cold and the primary cache dir exists but is itself empty', () => {
    const { fs } = fakeFs({ '/active': [], '/primary': [] })
    const r = seedAiQuizCache('/active', '/primary', { fs })
    expect(r.seeded).toBe(0)
    expect(r.cold).toBe(true)
    expect(r.message).toContain('COLD CACHE')
    expect(r.message).toContain('/primary')
  })

  it('is a no-op when primary and active dirs are the same path', () => {
    const { fs } = fakeFs({ '/same': [] })
    const r = seedAiQuizCache('/same', '/same', { fs })
    expect(r.seeded).toBe(0)
    expect(r.cold).toBe(true)
  })

  it('ignores non-ai-quiz files in the donor dir', () => {
    const { fs, dirs } = fakeFs({
      '/active': [],
      '/primary': [QUIZ('a'), 'a.md', 'a.codecheck.json', '_discovery.json'],
    })
    const r = seedAiQuizCache('/active', '/primary', { fs })
    expect(r.seeded).toBe(1)
    expect([...dirs['/active']]).toEqual([QUIZ('a')])
  })
})

describe('autoDetectPrimaryCacheDir', () => {
  it('maps a POSIX worktree cache dir to the primary-tree equivalent', () => {
    const active = '/home/tom/projects/tutorials-poc/.claude/worktrees/ai-author-parallel/.tutorial-cache'
    expect(autoDetectPrimaryCacheDir(active)).toBe('/home/tom/projects/tutorials-poc/.tutorial-cache')
  })

  it('maps a Windows worktree cache dir (backslashes) to the primary tree', () => {
    const active = 'D:\\projects\\tutorials-poc\\.claude\\worktrees\\ai-author-parallel\\.tutorial-cache'
    expect(autoDetectPrimaryCacheDir(active)).toBe('D:/projects/tutorials-poc/.tutorial-cache')
  })

  it('preserves the channel-specific cache dir name (qa)', () => {
    const active = '/r/.claude/worktrees/wt/.tutorial-cache-qa'
    expect(autoDetectPrimaryCacheDir(active)).toBe('/r/.tutorial-cache-qa')
  })

  it('returns undefined when not inside a worktree', () => {
    expect(autoDetectPrimaryCacheDir('/home/tom/projects/tutorials-poc/.tutorial-cache')).toBeUndefined()
  })
})
