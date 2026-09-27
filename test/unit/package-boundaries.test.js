import { test } from 'vitest'
import { execFileSync } from 'node:child_process'

test('package boundary lint passes on current tree', () => {
  // Should exit 0; throws on non-zero
  execFileSync('node', ['scripts/lint-package-boundaries.cjs'], { stdio: 'pipe' })
})
