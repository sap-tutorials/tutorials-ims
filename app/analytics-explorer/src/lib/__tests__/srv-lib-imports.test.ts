import { describe, it, expect } from 'vitest'
import { validateQuerySpec, specToSql } from '../srv-lib-imports'

describe('@srv-lib alias', () => {
  it('imports validateQuerySpec from srv/lib', () => {
    expect(typeof validateQuerySpec).toBe('function')
  })

  it('imports specToSql from srv/lib', () => {
    expect(typeof specToSql).toBe('function')
  })
})
