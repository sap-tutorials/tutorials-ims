// #badge-v2 — the camera ordering helper must await nextTick (so the <video>
// element in the v-if="scanning" branch is mounted) BEFORE calling scan().
// Regression guard for the bug where scan() read a null videoRef and threw.

import { describe, expect, it } from 'vitest'
import { beginScan } from '../scan-order'

describe('beginScan ordering (#badge-v2)', () => {
  it('awaits nextTick before invoking scan', async () => {
    const calls: string[] = []
    const setState = (s: string) => { calls.push(`state:${s}`) }
    const nextTickFn = () => { calls.push('nextTick'); return Promise.resolve() }
    const scanFn = () => { calls.push('scan'); return Promise.resolve('RESULT') }

    const result = await beginScan(setState, nextTickFn, scanFn)

    expect(result).toBe('RESULT')
    expect(calls).toEqual(['state:scanning', 'nextTick', 'scan'])
  })
})
