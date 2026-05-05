import { ref, readonly, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'

export interface Bucket {
  name: string
  count: number
  justUpdated: boolean
}

export interface RecentEvent {
  name: string
  timestamp: number
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

const DEMO_TAGS = [
  'SAP BTP', 'SAP HANA Cloud', 'SAP Fiori', 'SAP Build',
  'SAP Integration Suite', 'SAP Analytics Cloud', 'ABAP Cloud',
  'SAP AI Core', 'SAP CAP', 'SAP Mobile',
]

export function useEventStream() {
  const buckets = ref<Bucket[]>([])
  const totalCount = ref(0)
  const connectionState = ref<ConnectionState>('idle')
  const errorMessage = ref('')
  const speed = ref(0)
  const recentEvents = ref<RecentEvent[]>([])
  const bucketVelocity = ref(new Map<string, number>())

  let socket: Socket | null = null
  let demoInterval: ReturnType<typeof setInterval> | null = null
  let cronInterval: ReturnType<typeof setInterval> | null = null
  const messageTimestamps: number[] = []
  const bucketTimestamps = new Map<string, number[]>()

  function sortBuckets() {
    buckets.value.sort((a, b) => b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name))
  }

  function recalcTotal() {
    totalCount.value = buckets.value.reduce((sum, b) => sum + b.count, 0)
  }

  function removeOutdatedTimestamps() {
    const border = Date.now() - 60 * 60 * 1000
    for (let i = messageTimestamps.length - 1; i >= 0; i--) {
      if (messageTimestamps[i] < border) {
        messageTimestamps.splice(0, i)
        break
      }
    }
  }

  function speedApproximation(): number {
    if (messageTimestamps.length < 3) return 0
    const time = messageTimestamps[messageTimestamps.length - 1] - messageTimestamps[0]
    if (time === 0) return 0
    const approx = (60 * 60 * 1000) / time
    return Math.round(approx * messageTimestamps.length)
  }

  function startCron() {
    cronInterval = setInterval(() => {
      if (messageTimestamps.length < 3) return
      removeOutdatedTimestamps()
      speed.value = speedApproximation()

      const now = Date.now()
      const window = 5 * 60 * 1000
      const vel = new Map<string, number>()
      for (const [name, timestamps] of bucketTimestamps) {
        const recent = timestamps.filter(t => now - t < window)
        bucketTimestamps.set(name, recent)
        vel.set(name, recent.length / 5)
      }
      bucketVelocity.value = vel
    }, 500)
  }

  function applyUpdate(bucketName: string) {
    const existing = buckets.value.find(b => b.name === bucketName)
    if (existing) {
      existing.count++
      existing.justUpdated = true
    } else {
      buckets.value.push({ name: bucketName, count: 1, justUpdated: true })
    }
    messageTimestamps.push(Date.now())

    recentEvents.value = [
      { name: bucketName, timestamp: Date.now() },
      ...recentEvents.value,
    ].slice(0, 30)

    const ts = bucketTimestamps.get(bucketName) ?? []
    ts.push(Date.now())
    bucketTimestamps.set(bucketName, ts)

    sortBuckets()
    recalcTotal()
    setTimeout(() => {
      const b = buckets.value.find(b => b.name === bucketName)
      if (b) b.justUpdated = false
    }, 1200)
  }

  async function connect(baseUrl: string, eventId: number | string) {
    connectionState.value = 'connecting'
    errorMessage.value = ''
    const url = String(baseUrl).replace(/\/+$/, '')

    // Fetch initial bucket data from unauthenticated EventStreamService
    try {
      const res = await fetch(`${url}/rest/event-stream/getEventBuckets(eventLegacyId=${eventId})`)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const json = await res.json()
      const data: Array<{ bucketName: string; count: number }> = json.value ?? json
      buckets.value = data.map(b => ({ name: b.bucketName, count: b.count, justUpdated: false }))
      sortBuckets()
      recalcTotal()
    } catch (e) {
      connectionState.value = 'error'
      errorMessage.value = `Failed to fetch from ${url}: ${(e as Error).message}`
      return
    }

    // Connect via Socket.IO to EventStreamService
    socket = io(`${url}/ws/event-stream`, {
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    })

    socket.on('connect', () => {
      connectionState.value = 'connected'
      socket!.emit('wsContext', { context: String(eventId) })
    })

    socket.on('disconnect', () => {
      connectionState.value = 'reconnecting'
    })

    socket.on('connect_error', (err) => {
      connectionState.value = 'error'
      errorMessage.value = `WebSocket connection error: ${err.message}`
    })

    socket.on('tutorialCompleted', (data: { bucketName: string }) => {
      if (data.bucketName) applyUpdate(data.bucketName)
    })

    startCron()
  }

  function startDemo() {
    connectionState.value = 'connected'
    buckets.value = DEMO_TAGS.map(name => ({
      name,
      count: Math.floor(Math.random() * 80) + 5,
      justUpdated: false,
    }))
    sortBuckets()
    recalcTotal()
    demoInterval = setInterval(() => {
      const tag = DEMO_TAGS[Math.floor(Math.random() * DEMO_TAGS.length)]
      applyUpdate(tag)
    }, 800 + Math.random() * 1200)
    startCron()
  }

  function disconnect() {
    if (socket) { socket.disconnect(); socket = null }
    if (demoInterval) { clearInterval(demoInterval); demoInterval = null }
    if (cronInterval) { clearInterval(cronInterval); cronInterval = null }
    connectionState.value = 'idle'
  }

  onUnmounted(disconnect)

  return {
    buckets: readonly(buckets),
    totalCount: readonly(totalCount),
    connectionState: readonly(connectionState),
    errorMessage: readonly(errorMessage),
    speed: readonly(speed),
    recentEvents: readonly(recentEvents),
    bucketVelocity: readonly(bucketVelocity),
    connect, startDemo, disconnect,
  }
}
