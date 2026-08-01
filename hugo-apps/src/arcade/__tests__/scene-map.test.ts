import { describe, it, expect } from 'vitest'
import { sceneMap, avatarFile } from '../scene-map'

describe('sceneMap — faithful level->placement', () => {
  it('level 0 -> start cloud, avatar-1 bounce, 0 hearts', () => {
    expect(sceneMap(0)).toEqual({ cloud: 0, bounceClass: 'avatar-1', hearts: 0 })
  })
  it('levels 1..3 -> matching cloud, hearts = level', () => {
    expect(sceneMap(1)).toEqual({ cloud: 1, bounceClass: 'avatar-1', hearts: 1 })
    expect(sceneMap(2)).toEqual({ cloud: 2, bounceClass: 'avatar-2', hearts: 2 })
    expect(sceneMap(3)).toEqual({ cloud: 3, bounceClass: 'avatar-3', hearts: 3 })
  })
  it('level 4 -> nerdvana, infinite bounce', () => {
    expect(sceneMap(4)).toEqual({ cloud: 4, bounceClass: 'avatar-4', hearts: 0 })
  })
  it('clamps out-of-range level', () => {
    expect(sceneMap(9).cloud).toBe(4)
    expect(sceneMap(-1).cloud).toBe(0)
  })
  it('avatarFile maps + clamps index to Group-<n>.png', () => {
    expect(avatarFile('/images/devtoberfest', 3)).toBe('/images/devtoberfest/avatars/Group-3.png')
    expect(avatarFile('/images/devtoberfest', 99)).toBe('/images/devtoberfest/avatars/Group-37.png')
    expect(avatarFile('/images/devtoberfest', -5)).toBe('/images/devtoberfest/avatars/Group-0.png')
  })
})
