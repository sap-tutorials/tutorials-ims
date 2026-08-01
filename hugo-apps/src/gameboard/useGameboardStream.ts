import { ref, readonly, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import type { ConnectionState } from './types'

const DEBOUNCE_MS = 1200

export function useGameboardStream() {
  const connectionState = ref<ConnectionState>('idle')
  let socket: Socket | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function connect(baseUrl: string, eventId: string, onCompleted: () => void) {
    connectionState.value = 'connecting'
    const url = String(baseUrl || '').replace(/\/+$/, '') // '' → same-origin
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
    socket.on('disconnect', () => { connectionState.value = 'reconnecting' })
    socket.on('connect_error', () => { connectionState.value = 'error' })
    socket.on('tutorialCompleted', () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; onCompleted() }, DEBOUNCE_MS)
    })
  }

  function disconnect() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    if (socket) { socket.disconnect(); socket = null }
    connectionState.value = 'idle'
  }

  onUnmounted(disconnect)
  return { connectionState: readonly(connectionState), connect, disconnect }
}
