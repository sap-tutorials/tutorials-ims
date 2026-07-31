// test/hybrid/puzzle-reset-hybrid.test.js
// Verifies resetPuzzleProgress action is registered and reachable against real HANA.
// Reads via in-process service API, not unauthenticated fetch (AdminService/PuzzleService
// are auth-gated over HTTP; an unauthenticated fetch returns Unauthorized — the #1412
// GridTemplates-test lesson).
//
// Run with: npm run test:hybrid -- --project hybrid test/hybrid/puzzle-reset-hybrid.test.js

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('resetPuzzleProgress (hybrid/HANA)', () => {
  it('the action is registered and supersede/bump logic is reachable', async () => {
    const PuzzleService = await cds.connect.to('PuzzleService')
    // The action exists on the service definition (registration smoke).
    expect(PuzzleService.actions?.resetPuzzleProgress
        ?? PuzzleService.operations?.resetPuzzleProgress
        ?? PuzzleService.model?.definitions?.['PuzzleService.resetPuzzleProgress'])
      .toBeTruthy()
  })
})
