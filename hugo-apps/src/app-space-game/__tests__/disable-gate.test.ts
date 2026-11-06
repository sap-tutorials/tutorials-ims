import { describe, it, expect } from 'vitest'

describe('isGameDisabled', () => {
  /** Create a fake storage backed by a Map */
  function createFakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    const store = new Map<string, string>()
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    }
  }

  /** Create a storage that throws on all operations */
  function createThrowingStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    return {
      getItem: () => { throw new Error('Storage error') },
      setItem: () => { throw new Error('Storage error') },
      removeItem: () => { throw new Error('Storage error') },
    }
  }

  it('returns true and sets storage when nogame=1', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    const result = isGameDisabled('?nogame=1', storage)
    expect(result).toBe(true)
    expect(storage.getItem('appSpaceGameDisabled')).toBe('1')
  })

  it('returns false and removes storage when nogame=0', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    storage.setItem('appSpaceGameDisabled', '1')
    const result = isGameDisabled('?nogame=0', storage)
    expect(result).toBe(false)
    expect(storage.getItem('appSpaceGameDisabled')).toBeNull()
  })

  it('handles case-insensitive NoGame=1', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    const result = isGameDisabled('?NoGame=1', storage)
    expect(result).toBe(true)
    expect(storage.getItem('appSpaceGameDisabled')).toBe('1')
  })

  it('returns true when stored value exists and no param', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    storage.setItem('appSpaceGameDisabled', '1')
    const result = isGameDisabled('', storage)
    expect(result).toBe(true)
  })

  it('returns false when no param and empty storage', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    const result = isGameDisabled('', storage)
    expect(result).toBe(false)
  })

  it('returns true when nogame=1 and storage is null', async () => {
    const { isGameDisabled } = await import('../feature')
    const result = isGameDisabled('?nogame=1', null)
    expect(result).toBe(true)
  })

  it('does not throw when storage throws on nogame=1', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createThrowingStorage()
    expect(() => isGameDisabled('?nogame=1', storage)).not.toThrow()
    const result = isGameDisabled('?nogame=1', storage)
    expect(result).toBe(true)
  })

  it('returns false and does not throw when storage throws with no param', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createThrowingStorage()
    expect(() => isGameDisabled('', storage)).not.toThrow()
    const result = isGameDisabled('', storage)
    expect(result).toBe(false)
  })

  it('handles nogame=true', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    const result = isGameDisabled('?nogame=true', storage)
    expect(result).toBe(true)
    expect(storage.getItem('appSpaceGameDisabled')).toBe('1')
  })

  it('handles nogame=false', async () => {
    const { isGameDisabled } = await import('../feature')
    const storage = createFakeStorage()
    storage.setItem('appSpaceGameDisabled', '1')
    const result = isGameDisabled('?nogame=false', storage)
    expect(result).toBe(false)
    expect(storage.getItem('appSpaceGameDisabled')).toBeNull()
  })
})
