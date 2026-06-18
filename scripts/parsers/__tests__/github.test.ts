import { describe, it, expect } from 'vitest'
import { EXCLUDED_REPOS } from '../github.js'

describe('EXCLUDED_REPOS — discovery contract (#382)', () => {
  it('does NOT exclude meta-tutorials', () => {
    // Pinning issue #382: meta-tutorials/tutorials/<slug>/ folders should
    // participate in the build pipeline. Discovery only reads each repo's
    // tutorials/ subtree (github.ts:397 and 495), so siblings like
    // run-book/ and task-interview-coach/ remain invisible without any
    // path filter.
    expect(EXCLUDED_REPOS.has('meta-tutorials')).toBe(false)
  })

  it('still excludes tutorials-ims itself', () => {
    // Sanity: removing meta-tutorials must not accidentally unblock
    // tutorials-ims (this repo) from discovering itself recursively.
    expect(EXCLUDED_REPOS.has('tutorials-ims')).toBe(true)
  })
})
