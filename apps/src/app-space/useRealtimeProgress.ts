import { ref, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'

export interface CompletionEvent {
  bucketName: string
  tutorialTitle: string
  userName: string
}

export function useRealtimeProgress(baseUrl: string, eventId: string | number) {
  const lastCompletion = ref<CompletionEvent | null>(null)
  const connected = ref(false)

  const url = String(baseUrl).replace(/\/+$/, '')

  const socket: Socket = io(`${url}/display`, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  })

  socket.on('connect', () => {
    connected.value = true
    socket.emit('wsContext', { context: String(eventId) })
  })

  socket.on('disconnect', () => {
    connected.value = false
  })

  socket.on('tutorialCompleted', (data: CompletionEvent) => {
    lastCompletion.value = data
  })

  onUnmounted(() => socket.disconnect())

  return { lastCompletion, connected }
}
