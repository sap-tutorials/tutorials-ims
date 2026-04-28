import { ref, readonly, onUnmounted } from 'vue'
import { Client } from '@stomp/stompjs'

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

  let stompClient: Client | null = null
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

  async function connect(imsUrl: string, eventId: number) {
    connectionState.value = 'connecting'
    errorMessage.value = ''

    const baseUrl = imsUrl.replace(/\/+$/, '')

    try {
      const res = await fetch(`${baseUrl}/statistic/events/${eventId}/buckets`)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const data: Array<{ name: string; count: number }> = await res.json()
      buckets.value = data.map(b => ({ ...b, justUpdated: false }))
      sortBuckets()
      recalcTotal()
    } catch (e) {
      connectionState.value = 'error'
      errorMessage.value = `Failed to fetch buckets from ${baseUrl}: ${(e as Error).message}`
      return
    }

    const wsScheme = baseUrl.startsWith('https') ? 'wss' : 'ws'
    const wsHost = baseUrl.replace(/^https?:\/\//, '')
    const wsUrl = `${wsScheme}://${wsHost}/display/websocket`

    stompClient = new Client({
      brokerURL: wsUrl,
      reconnectDelay: 5000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,

      onConnect: () => {
        connectionState.value = 'connected'
        stompClient!.subscribe(`/topic/events/${eventId}/tutorials`, (message) => {
          try {
            const update = JSON.parse(message.body)
            if (update.bucketName) {
              applyUpdate(update.bucketName)
            }
          } catch { /* ignore malformed messages */ }
        })
      },

      onDisconnect: () => {
        connectionState.value = 'reconnecting'
      },

      onStompError: (frame) => {
        connectionState.value = 'error'
        errorMessage.value = `STOMP error: ${frame.headers['message'] ?? 'Unknown'}`
      },

      onWebSocketClose: () => {
        if (connectionState.value === 'connected') {
          connectionState.value = 'reconnecting'
        }
      },
    })

    stompClient.activate()
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
    if (stompClient) {
      stompClient.deactivate()
      stompClient = null
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
