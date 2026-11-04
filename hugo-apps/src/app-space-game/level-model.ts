import type { AppSpaceData, AppSpaceSegment, AppSpaceItem } from './types'
import type { LevelModel, Zone, Coin, Gate, Goal } from './types'
import { placeHazards } from './obstacles'

// Palette of 11 distinct hex colors (SAP Horizon-inspired, on-brand-ish)
const ZONE_COLOR_PALETTE = [
  '#0B5394', // SAP Blue
  '#1F70C1', // Bright Blue
  '#0F5133', // Dark Green
  '#107C10', // Accent Green
  '#6E3932', // Warm Brown
  '#A4373A', // Red Accent
  '#6B3FA0', // Purple
  '#004B87', // Navy
  '#C85E1E', // Orange
  '#5E4C3C', // Taupe
  '#2D3B45', // Slate
]

export function zoneColor(colorIndex: number): string {
  const index = colorIndex % ZONE_COLOR_PALETTE.length
  return ZONE_COLOR_PALETTE[index]
}

function flattenSegments(segments: AppSpaceSegment[]): {
  items: AppSpaceItem[]
  checkpointIndices: Map<number, AppSpaceItem>
} {
  const items: AppSpaceItem[] = []
  const checkpointIndices = new Map<number, AppSpaceItem>()

  segments.forEach(segment => {
    if (segment.kind === 'linear' || segment.kind === 'parallel-any') {
      segment.items.forEach(item => {
        if (item.type === 'TUTORIAL') {
          items.push(item)
        } else if (item.type === 'CHECKPOINT') {
          checkpointIndices.set(items.length - 1, item)
        } else if (item.type === 'PRIZE') {
          items.push(item)
        }
      })
    } else if (segment.kind === 'fork') {
      // Process lanes in order, then items within each lane
      segment.lanes.forEach(lane => {
        lane.items.forEach(item => {
          if (item.type === 'TUTORIAL') {
            items.push(item)
          } else if (item.type === 'CHECKPOINT') {
            checkpointIndices.set(items.length - 1, item)
          } else if (item.type === 'PRIZE') {
            items.push(item)
          }
        })
      })
    }
  })

  return { items, checkpointIndices }
}

function buildCoinsAndGates(
  items: AppSpaceItem[],
  checkpointIndices: Map<number, AppSpaceItem>,
  isAuthenticated: boolean,
  isLocked: boolean
): { coins: Coin[]; gates: Gate[] } {
  const coins: Coin[] = []
  const gates: Gate[] = []

  items.forEach((item, idx) => {
    if (item.type === 'TUTORIAL') {
      const coin: Coin = {
        title: item.title,
        done: isAuthenticated && item.status === 'COMPLETED',
        available: !isLocked,
      }
      coins.push(coin)
    } else if (item.type === 'PRIZE') {
      // PRIZE items are represented as coins
      const coin: Coin = {
        title: item.title,
        done: isAuthenticated && item.status === 'COMPLETED',
        available: !isLocked,
      }
      coins.push(coin)
    }
  })

  // Process checkpoints: if they have prizeId, they become goals (handled elsewhere)
  // Otherwise they become gates
  checkpointIndices.forEach((checkpointItem, coinIndex) => {
    if (!checkpointItem.prizeId) {
      gates.push({
        afterCoinIndex: coinIndex,
      })
    }
  })

  return { coins, gates }
}

function findGoal(
  items: AppSpaceItem[],
  checkpointIndices: Map<number, AppSpaceItem>,
  trackId: string
): Goal {
  // First, look for a literal PRIZE item
  const prizeItem = items.find(item => item.type === 'PRIZE')
  if (prizeItem) {
    return {
      kind: 'prize',
      label: prizeItem.title,
      prizeId: prizeItem.prizeId ?? null,
      trackId,
    }
  }

  // Next, look for a CHECKPOINT with prizeId
  let checkpointWithPrize: AppSpaceItem | undefined
  checkpointIndices.forEach(checkpointItem => {
    if (checkpointItem.prizeId) {
      checkpointWithPrize = checkpointItem
    }
  })

  if (checkpointWithPrize) {
    return {
      kind: 'checkpoint',
      label: checkpointWithPrize.title,
      prizeId: checkpointWithPrize.prizeId ?? null,
      trackId,
    }
  }

  // Default: track goal
  return {
    kind: 'track',
    label: 'Complete Track',
    prizeId: null,
    trackId,
  }
}

export function buildLevelModel(data: AppSpaceData): LevelModel {
  const zones: Zone[] = []
  const isAuthenticated = data.authenticated ?? false

  data.paths.forEach((track, trackIndex) => {
    const segments = track.segments ?? []

    if (segments.length === 0) {
      return // Skip tracks with no segments
    }

    const { items, checkpointIndices } = flattenSegments(segments)

    // Determine if zone is locked (any item is unlocked:false)
    const isLocked = items.some(item => item.unlocked === false)

    // Filter out PRIZE items from coin list, keep only TUTORIAL
    const tutorialItems = items.filter(item => item.type === 'TUTORIAL')

    // Build coins and gates
    const { coins, gates } = buildCoinsAndGates(items, checkpointIndices, isAuthenticated, isLocked)

    // Determine if zone is cleared: at least 1 tutorial AND all tutorials COMPLETED
    const allTutorialsCompleted =
      isAuthenticated && tutorialItems.length > 0 && tutorialItems.every(item => item.status === 'COMPLETED')
    const cleared = allTutorialsCompleted

    // Build goal
    const goal = findGoal(items, checkpointIndices, track.id)

    const { obstacles, pits } = placeHazards(coins.length, trackIndex)

    const zone: Zone = {
      id: track.id,
      title: track.title,
      colorIndex: trackIndex,
      cleared,
      locked: isLocked,
      coins,
      gates,
      goal,
      obstacles,
      pits,
    }

    zones.push(zone)
  })

  return { zones }
}
