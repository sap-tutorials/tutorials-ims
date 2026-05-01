import { ref, readonly, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'

export interface Bucket {
  name: string
  count: number
  justUpdated: boolean
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

const DEMO_TAGS = [
  'SAP BTP', 'SAP HANA Cloud', 'SAP Fiori', 'SAP Build',
  'SAP Integration Suite', 'SAP Analytics Cloud', 'ABAP Cloud',
  'SAP AI Core', 'SAP CAP', 'SAP Mobile',
]

function generateDemoBuckets(): Bucket[] {
  return DEMO_TAGS.map(name => ({
    name,
    count: Math.floor(Math.random() * 80) + 5,
    justUpdated: false,
  }))
}

export function useEventStream() {
  const buckets = ref<Bucket[]>([])
  const totalCount = ref(0)
  const connectionState = ref<ConnectionState>('idle')
  const errorMessage = ref('')

  let socket: Socket | null = null
  let demoInterval: ReturnType<typeof setInterval> | null = null

  function sortBuckets() {
    buckets.value.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      return a.name.localeCompare(b.name)
    })
  }

  function recalcTotal() {
    totalCount.value = buckets.value.reduce((sum, b) => sum + b.count, 0)
  }

  function applyUpdate(bucketName: string) {
    const existing = buckets.value.find(b => b.name === bucketName)
    if (existing) {
      existing.count++
      existing.justUpdated = true
    } else {
      buckets.value.push({ name: bucketName, count: 1, justUpdated: true })
    }
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
      errorMessage.value = `Failed to fetch buckets from ${url}: ${(e as Error).message}`
      return
    }

    // Connect via Socket.IO to EventStreamService
    socket = io(`${url}/ws/event-stream`, {
      transports: ['websocket'],
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

    socket.on('connect_error', () => {
      connectionState.value = 'error'
      errorMessage.value = 'WebSocket connection error'
    })

    socket.on('tutorialCompleted', (data: { bucketName: string }) => {
      if (data.bucketName) applyUpdate(data.bucketName)
    })
  }

  function startDemo() {
    connectionState.value = 'connected'
    buckets.value = generateDemoBuckets()
    sortBuckets()
    recalcTotal()

    demoInterval = setInterval(() => {
      const tag = DEMO_TAGS[Math.floor(Math.random() * DEMO_TAGS.length)]
      applyUpdate(tag)
    }, 2000 + Math.random() * 4000)
  }

  function disconnect() {
    if (socket) {
      socket.disconnect()
      socket = null
    }
    if (demoInterval) {
      clearInterval(demoInterval)
      demoInterval = null
    }
    connectionState.value = 'idle'
  }

  onUnmounted(disconnect)

  return {
    buckets: readonly(buckets),
    totalCount: readonly(totalCount),
    connectionState: readonly(connectionState),
    errorMessage: readonly(errorMessage),
    connect,
    startDemo,
    disconnect,
  }
}
