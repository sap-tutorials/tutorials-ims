# Real-Time Event Display Design

**Date:** 2026-04-30
**Status:** Approved
**Scope:** Replace custom STOMP broker with `@cap-js-community/websocket` plugin; wire AppSpace.vue for live updates with celebration effects

## Summary

Replace the hand-rolled STOMP-over-WebSocket broker (`srv/lib/stomp-broker.js`) with the `@cap-js-community/websocket` CAP plugin using Socket.IO transport. Expose two CDS WebSocket services: an unauthenticated `EventStreamService` for kiosk displays and an authenticated `DisplayService` (extended with WebSocket protocol) for logged-in users. Rewrite both client apps (`display-app/`, `apps/`) from `@stomp/stompjs` to `socket.io-client`. Add real-time celebration effects (confetti, toast notifications) to AppSpace.vue.

## Architecture

```
Developer completes tutorial
        ↓
DeveloperService.after('createTaskRecord')
        ↓
srv.emit('tutorialCompleted', payload, { contexts: [eventLegacyId] })  // header-based context filter
        ↓
┌────────────────────────────────┐  ┌────────────────────────────────┐
│  EventStreamService            │  │  DisplayService                │
│  @protocol: 'websocket'       │  │  @protocol: ['odata','websocket']│
│  @requires: 'any'             │  │  @requires: 'DisplayApp'       │
│  /ws/event-stream              │  │  /display (absolute @path)     │
│                                │  │                                │
│  → display-app (kiosk)         │  │  → AppSpace.vue (user)         │
│    socket.io-client            │  │    socket.io-client + XSUAA    │
│    No auth                     │  │    Confetti + toast + badge    │
└────────────────────────────────┘  └────────────────────────────────┘
```

**Transport:** Socket.IO (`cds.websocket.kind: "socket.io"`)
**Context filtering:** Clients emit `wsContext` to join an event context by legacyId; server emits with `contexts` header to scope broadcasts
**Scaling:** `@socket.io/redis-adapter` for multi-instance CF deployments (deferred until needed)

## CDS Service Definitions

### New: EventStreamService

```cds
// srv/event-stream-service.cds
@protocol: 'websocket'
@requires: 'any'
@path: 'event-stream'
service EventStreamService {
  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
  }

  // Unauthenticated bucket counts for kiosk initial load
  function getEventBuckets(eventLegacyId : Integer) returns many {
    bucketName  : String;
    count       : Integer;
    percentage  : Decimal;
  };
}
```

### Modified: DisplayService

```cds
// srv/display-service.cds (add websocket protocol + event)
@protocol: ['odata', 'websocket']
@requires: 'DisplayApp'
@path: '/display'
service DisplayService {
  // ... existing entities and functions unchanged ...

  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
    userName      : String;
  }
}
```

The `userName` field is only available on the authenticated `DisplayService` channel — allows AppSpace to show who completed the tutorial.

## Server-Side Event Emission

```javascript
// srv/developer-service.js — modified after('createTaskRecord') handler

this.after('createTaskRecord', async (result, req) => {
  if (!result || result.status !== 'COMPLETED') return
  if (result.taskType !== 'TUTORIAL' || !result.event_ID) return

  const event = await SELECT.one.from(Events).where({ ID: result.event_ID })
  if (!event) return

  const tutorial = await SELECT.one.from(Tutorials).where({ legacyId: result.taskLegacyId })
  const user = await SELECT.one.from(Users).where({ ID: result.user_ID })

  const payload = {
    bucketName: tutorial?.primaryTag || 'unknown',
    completeDate: new Date().toISOString().slice(0, 10),
    tutorialTitle: tutorial?.title || 'Unknown Tutorial',
  }

  // Broadcast to kiosks (unauthenticated, no user info)
  // 'contexts' header scopes delivery to clients who joined that context
  const eventStream = await cds.connect.to('EventStreamService')
  await eventStream.tx(req).emit('tutorialCompleted', payload, { contexts: [String(event.legacyId)] })

  // Broadcast to authenticated clients (with user name)
  const display = await cds.connect.to('DisplayService')
  await display.tx(req).emit('tutorialCompleted',
    { ...payload, userName: user?.displayName || 'Someone' },
    { contexts: [String(event.legacyId)] }
  )
})
```

### Removed from srv/server.js

```javascript
// DELETE entirely:
cds.on('listening', ({ server }) => {
  const { wss, publish } = createStompBroker(server)
  cds.broker = { wss, publish }
})
```

## Client: display-app (Kiosk)

### Rewritten composable (illustrative — Socket.IO wiring only)

The code below shows **only** the transport-layer change (STOMP → Socket.IO). The full composable preserves the existing imperative API shape: `connect(baseUrl, eventId)`, `startDemo()`, `disconnect()`, and all returned refs (`buckets`, `totalCount`, `connectionState`, `errorMessage`, `speed`, `recentEvents`, `bucketVelocity`). Internal bookkeeping (`applyUpdate`, speed calculation cron, `justUpdated` flash flag, `bucketTimestamps`) carries over unchanged.

```typescript
// display-app/src/event-stream.ts — TRANSPORT CHANGE ONLY (simplified)
import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'

export function useEventStream() {
  // ... all existing refs and internal state preserved ...

  let socket: Socket | null = null

  async function connect(baseUrl: string, eventId: string) {
    connectionState.value = 'connecting'

    // Fetch initial bucket counts (unauthenticated EventStreamService endpoint)
    try {
      const res = await fetch(`${baseUrl}/ws/event-stream/getEventBuckets(eventLegacyId=${eventId})`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // ... populate buckets from data.value ...
    } catch (e) {
      connectionState.value = 'error'
      errorMessage.value = `Failed to fetch: ${(e as Error).message}`
      return
    }

    socket = io(`${baseUrl}/ws/event-stream`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    })

    socket.on('connect', () => {
      connectionState.value = 'connected'
      socket!.emit('wsContext', { context: eventId })
    })

    socket.on('disconnect', () => { connectionState.value = 'reconnecting' })
    socket.on('connect_error', () => { connectionState.value = 'error' })

    socket.on('tutorialCompleted', (data) => {
      applyUpdate(data.bucketName)  // existing internal method
    })

    startCron()
  }

  function disconnect() {
    if (socket) { socket.disconnect(); socket = null }
    // ... clear intervals ...
    connectionState.value = 'idle'
  }

  // startDemo() unchanged — generates local fake data, no server connection

  onUnmounted(disconnect)

  return {
    buckets, totalCount, connectionState, errorMessage,
    speed, recentEvents, bucketVelocity,
    connect, startDemo, disconnect,
  }
}
```

### Impact on App.vue

Zero API changes — the composable still returns the same refs and methods (`buckets`, `totalCount`, `connectionState`, `errorMessage`, `speed`, `recentEvents`, `bucketVelocity`, `connect`, `startDemo`, `disconnect`). All 8 rotating views, animations, and confetti continue working as-is.

### What changes internally

Only two things change inside the composable:
1. **Transport:** `@stomp/stompjs` Client → `socket.io-client` Socket (connect/subscribe/disconnect)
2. **Initial data URL:** Old IMS path `/statistic/events/${eventId}/buckets` → CAP path `/ws/event-stream/getEventBuckets(eventLegacyId=${eventId})`

Everything else (speed approximation, bucket velocity, recent events, demo mode, cron interval) remains byte-for-byte identical.

## Client: AppSpace.vue (Celebration Mode)

### New composable

```typescript
// apps/src/app-space/useRealtimeProgress.ts
import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'

export function useRealtimeProgress(baseUrl: string, eventId: string) {
  const lastCompletion = ref<{
    bucketName: string
    tutorialTitle: string
    userName: string
  } | null>(null)
  const connected = ref(false)

  const socket: Socket = io(`${baseUrl}/display`, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    // Auth automatic — browser sends XSUAA cookie on HTTP upgrade
  })

  socket.on('connect', () => {
    connected.value = true
    // Join event context (re-emitted on reconnect since 'connect' fires again)
    socket.emit('wsContext', { context: eventId })
  })

  socket.on('disconnect', () => { connected.value = false })

  socket.on('tutorialCompleted', (data) => {
    lastCompletion.value = data
  })

  onUnmounted(() => socket.disconnect())

  return { lastCompletion, connected }
}
```

### Integration in AppSpace.vue

```typescript
const { lastCompletion, connected } = useRealtimeProgress(baseUrl, eventId)
const { fireConfetti } = useConfetti()

watch(lastCompletion, (completion) => {
  if (!completion) return
  updateBucketCount(completion.bucketName)
  fireConfetti()
  showToast(`${completion.userName} completed "${completion.tutorialTitle}"!`)
  if (completion.userName === currentUser.value?.displayName) {
    triggerPersonalCelebration()
  }
})
```

### Celebration behaviors

| Trigger | Effect |
|---------|--------|
| Any completion in event | Confetti burst + toast notification (3s) |
| Current user's own completion | Larger confetti + badge glow animation |
| Multiple completions within 500ms | Debounce into "3 people just completed tutorials!" |

### Confetti

Copy `useConfetti.ts` (~50 lines) from `display-app/src/composables/` into `apps/src/composables/`. No shared workspace needed for one utility.

## Configuration

### package.json dependencies

**Add (root):**
- `@cap-js-community/websocket: ^1.x`
- `socket.io: ^4.x`

**Remove (root):**
- `ws: ^8.20.0`
- `@stomp/stompjs: ^7.3.0`

**Add (display-app):**
- `socket.io-client: ^4.x`

**Remove (display-app):**
- `@stomp/stompjs: ^7.3.0`

**Add (apps):**
- `socket.io-client: ^4.x`

**Remove (apps):**
- `@stomp/stompjs` (if listed)

### CDS configuration

```jsonc
// package.json "cds" section
{
  "websocket": {
    "kind": "socket.io"
  }
}
```

### Production scaling (deferred)

```jsonc
// When srv scales to >1 instance:
{
  "websocket": {
    "kind": "socket.io",
    "adapter": {
      "impl": "@socket.io/redis-adapter",
      "options": { "key": "tutorials-ws" }
    }
  }
}
```

Requires Redis on BTP (hyperscaler option). Not needed for single-instance deployment.

### XSUAA

No changes — `DisplayApp` scope already exists in `xs-security.json`. AppSpace users already have it.

## Files Changed

| Action | File | Description |
|--------|------|-------------|
| CREATE | `srv/event-stream-service.cds` | New unauthenticated WebSocket service |
| CREATE | `srv/event-stream-service.js` | Handler for `getEventBuckets` (delegates to same logic as DisplayService) |
| CREATE | `apps/src/app-space/useRealtimeProgress.ts` | Socket.IO composable for AppSpace |
| CREATE | `apps/src/composables/useConfetti.ts` | Copied from display-app |
| MODIFY | `srv/display-service.cds` | Add `@protocol: ['odata','websocket']` + event |
| MODIFY | `srv/developer-service.js` | Replace `cds.broker.publish` with `srv.emit` |
| MODIFY | `srv/server.js` | Remove STOMP broker `cds.on('listening')` block |
| MODIFY | `display-app/src/event-stream.ts` | Rewrite: STOMP → Socket.IO |
| MODIFY | `display-app/package.json` | Swap @stomp/stompjs → socket.io-client |
| MODIFY | `apps/src/event-display/useEventStream.ts` | Rewrite transport: STOMP → Socket.IO (preserve existing API surface) |
| MODIFY | `apps/src/event-display/EventDisplay.vue` | Update to use rewritten composable |
| MODIFY | `apps/src/app-space/AppSpace.vue` | Add realtime watch + celebration effects |
| MODIFY | `apps/package.json` | Add socket.io-client, remove @stomp/stompjs |
| MODIFY | `package.json` (root) | Add plugin + socket.io, remove ws + @stomp/stompjs |
| DELETE | `srv/lib/stomp-broker.js` | Replaced by plugin |

## Testing

- **Unit tests:** Verify `srv.emit()` fires with correct payload and context after task record creation. Mock the WebSocket layer (plugin doesn't create servers during `cds.test()`).
- **Hybrid tests:** Unchanged — test data logic, not WebSocket transport.
- **Manual integration:** Connect `display-app` and `AppSpace` to local `cds watch`, create a task record, verify both receive the event.
- **Smoke tests:** Add a test verifying `/ws/event-stream` endpoint responds to Socket.IO handshake (HTTP 200 on polling transport).

## Migration Notes

- This is a breaking change for the WebSocket protocol (STOMP → Socket.IO). Both client apps must be deployed simultaneously with the backend.
- Demo mode in display-app remains unchanged (generates local fake data, no server connection).
- **Reconnection:** Socket.IO `connect` event fires on both initial connection and reconnection. The `wsContext` emit in the `connect` handler ensures context is re-joined after any disconnect — no additional reconnection logic needed.
- **Path convention:** The `@cap-js-community/websocket` plugin mounts WebSocket endpoints using the service's `@path`. For relative paths (no leading slash, e.g., `'event-stream'`), the plugin adds a `/ws/` prefix → `/ws/event-stream`. For absolute paths (leading slash, e.g., `'/display'`), it uses the path verbatim → `/display`. The existing DisplayService uses an absolute `@path: '/display'`, so its WebSocket endpoint is at `/display` (same as OData). EventStreamService uses relative `@path: 'event-stream'` → WebSocket at `/ws/event-stream`.
