import { describe, it, expect } from 'vitest'
import { browseDataFile } from '../fetch-tutorials'

describe('browseDataFile channel awareness', () => {
  it('writes prod browse.json under hugo/data', () => {
    expect(browseDataFile('prod').replace(/\\/g, '/')).toMatch(/hugo\/data\/browse\.json$/)
  })
  it('writes qa browse.json under hugo/data-qa', () => {
    expect(browseDataFile('qa').replace(/\\/g, '/')).toMatch(/hugo\/data-qa\/browse\.json$/)
  })
})
