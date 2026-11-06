import { describe, it, expect } from 'vitest'
import { buildLevelModel, zoneColor } from '../level-model'
import type { AppSpaceData } from '../types'

describe('buildLevelModel', () => {
  it('empty paths -> zones.length === 0', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [],
    }
    const result = buildLevelModel(data)
    expect(result.zones).toHaveLength(0)
  })

  it('one linear path, 3 TUTORIAL items  -> 1 zone, 3 coins in order, titles preserved', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track1',
          title: 'Track One',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial A',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 2,
                  title: 'Tutorial B',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 3,
                  title: 'Tutorial C',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones).toHaveLength(1)
    expect(result.zones[0].coins).toHaveLength(3)
    expect(result.zones[0].coins[0].title).toBe('Tutorial A')
    expect(result.zones[0].coins[1].title).toBe('Tutorial B')
    expect(result.zones[0].coins[2].title).toBe('Tutorial C')
  })

  it('fork + parallel-any segments  -> coins flattened to one ordered list', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track2',
          title: 'Track Two',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Linear 1',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
            {
              order: 1,
              kind: 'parallel-any',
              items: [
                {
                  imsId: 2,
                  title: 'Cluster 1',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 3,
                  title: 'Cluster 2',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
            {
              order: 2,
              kind: 'fork',
              lanes: [
                {
                  label: 'Lane A',
                  items: [
                    {
                      imsId: 4,
                      title: 'Fork Lane A 1',
                      type: 'TUTORIAL',
                      status: 'NEW',
                      progress: 0,
                      experience: '100',
                      timeToComplete: 30,
                      url: '',
                      description: '',
                    },
                  ],
                },
                {
                  label: 'Lane B',
                  items: [
                    {
                      imsId: 5,
                      title: 'Fork Lane B 1',
                      type: 'TUTORIAL',
                      status: 'NEW',
                      progress: 0,
                      experience: '100',
                      timeToComplete: 30,
                      url: '',
                      description: '',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones).toHaveLength(1)
    expect(result.zones[0].coins).toHaveLength(5)
    expect(result.zones[0].coins[0].title).toBe('Linear 1')
    expect(result.zones[0].coins[1].title).toBe('Cluster 1')
    expect(result.zones[0].coins[2].title).toBe('Cluster 2')
    expect(result.zones[0].coins[3].title).toBe('Fork Lane A 1')
    expect(result.zones[0].coins[4].title).toBe('Fork Lane B 1')
  })

  it('path with a literal type:PRIZE item  -> goal.kind==="prize"', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track3',
          title: 'Track Three',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: null,
                  title: 'The Prize',
                  type: 'PRIZE',
                  status: 'NEW',
                  progress: 0,
                  experience: '0',
                  timeToComplete: 0,
                  url: '',
                  description: '',
                  prizeId: 42,
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].goal.kind).toBe('prize')
    expect(result.zones[0].goal.label).toBe('The Prize')
    expect(result.zones[0].goal.prizeId).toBe(42)
  })

  it('path whose only prize is type:CHECKPOINT + prizeId  -> goal.kind==="checkpoint", prizeId preserved', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track4',
          title: 'Track Four',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 2,
                  title: 'Checkpoint Prize',
                  type: 'CHECKPOINT',
                  status: 'NEW',
                  progress: 0,
                  experience: '50',
                  timeToComplete: 0,
                  url: '',
                  description: '',
                  prizeId: 99,
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].goal.kind).toBe('checkpoint')
    expect(result.zones[0].goal.label).toBe('Checkpoint Prize')
    expect(result.zones[0].goal.prizeId).toBe(99)
  })

  it('path with neither PRIZE nor prizeId CHECKPOINT  -> goal.kind==="track", trackId set', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track5',
          title: 'Track Five',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].goal.kind).toBe('track')
    expect(result.zones[0].goal.trackId).toBe('track5')
  })

  it('authenticated + some status:COMPLETED  -> those coins done:true; zone with all tutorials COMPLETED  -> cleared:true', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      authenticated: true,
      type: 'test',
      paths: [
        {
          id: 'track6',
          title: 'Track Six',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial 1',
                  type: 'TUTORIAL',
                  status: 'COMPLETED',
                  progress: 100,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 2,
                  title: 'Tutorial 2',
                  type: 'TUTORIAL',
                  status: 'COMPLETED',
                  progress: 100,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].coins[0].done).toBe(true)
    expect(result.zones[0].coins[1].done).toBe(true)
    expect(result.zones[0].cleared).toBe(true)
  })

  it('anonymous payload (no authenticated, items lack status)  -> all coins available:true, done:false; no throw', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track7',
          title: 'Track Seven',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial',
                  type: 'TUTORIAL',
                  // no status property
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].coins[0].done).toBe(false)
    expect(result.zones[0].coins[0].available).toBe(true)
  })

  it('unlocked:false items  -> zone locked:true, coins available:false', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track8',
          title: 'Track Eight',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Locked Tutorial',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                  unlocked: false,
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].locked).toBe(true)
    expect(result.zones[0].coins[0].available).toBe(false)
  })

  it('CHECKPOINT item mid-list  -> a Gate with correct afterCoinIndex', () => {
    const data: AppSpaceData = {
      eventId: 1,
      eventName: 'Test Event',
      type: 'test',
      paths: [
        {
          id: 'track9',
          title: 'Track Nine',
          description: '',
          items: [],
          segments: [
            {
              order: 0,
              kind: 'linear',
              items: [
                {
                  imsId: 1,
                  title: 'Tutorial 1',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
                {
                  imsId: 2,
                  title: 'Checkpoint',
                  type: 'CHECKPOINT',
                  status: 'NEW',
                  progress: 0,
                  experience: '50',
                  timeToComplete: 0,
                  url: '',
                  description: '',
                  // no prizeId, so becomes a gate
                },
                {
                  imsId: 3,
                  title: 'Tutorial 2',
                  type: 'TUTORIAL',
                  status: 'NEW',
                  progress: 0,
                  experience: '100',
                  timeToComplete: 30,
                  url: '',
                  description: '',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = buildLevelModel(data)
    expect(result.zones[0].coins).toHaveLength(2) // only tutorials
    expect(result.zones[0].gates).toHaveLength(1)
    expect(result.zones[0].gates[0].afterCoinIndex).toBe(0)
  })

  it('zoneColor(0..11) returns distinct hex strings, wraps at palette length', () => {
    const colors = Array.from({ length: 12 }, (_, i) => zoneColor(i))
    // Check that the first 11 are distinct
    const uniqueColors = new Set(colors.slice(0, 11))
    expect(uniqueColors.size).toBe(11)

    // Check wraparound: index 11 should equal index 0 (mod palette length)
    expect(zoneColor(11)).toBe(zoneColor(11 % 11))
    // And verify palette length is 11
    expect(zoneColor(0)).toBe(zoneColor(11))

    // Verify all are valid hex colors
    colors.forEach(color => {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    })
  })
})
