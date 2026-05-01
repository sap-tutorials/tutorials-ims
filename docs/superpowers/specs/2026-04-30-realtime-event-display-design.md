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
srv.emit('tutorialCompleted', payload, { contexts: [eventLegacyId] })
        ↓
┌────────────────────────────────┐  ┌────────────────────────────────┐
│  EventStreamService            │  │  DisplayService                │
│  @protocol: 'websocket'       │  │  @protocol: ['odata','websocket']│
│  @requires: 'any'             │  │  @requires: 'DisplayApp'       │
│  /ws/event-stream              │  │  /ws/display                   │
│                                │  │                                │
│  → display-app (kiosk)         │  │  → AppSpace.vue (user)         │
│    socket.io-client            │  │    socket.io-client + XSUAA    │
│    No auth                     │  │    Confetti + toast + badge    │
└────────────────────────────────┘  └────────────────────────────────┘
```

**Transport:** Socket.IO (`cds.websocket.kind: "socket.io"`)
**Context filtering:** Clients `enter` an event context by legacyId; broadcasts scoped to that context
**Scaling:** `@socket.io/redis-adapter` for multi-instance CF deployments (deferred until needed)

## CDS Service Definitions

### New: EventStreamService

```cds
// srv/event-stream-service.cds
@protocol: 'websocket'
@requires: 'any'
@path: '/event-stream'
service EventStreamService {
  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
  }
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
const EventStreamService = cds.connect.to('EventStreamService')
const DisplayService = cds.connect.to('DisplayService')

this.after('createTaskRecord', async (result) => {
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
  const eventStream = await EventStreamService
  eventStream.emit('tutorialCompleted', payload, { contexts: [String(event.legacyId)] })

  // Broadcast to authenticated clients (with user name)
  const display = await DisplayService
  display.emit('tutorialCompleted',
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

### Rewritten composable

```typescript
// display-app/src/event-stream.ts
import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'

export function useEventStream(baseUrl: string, eventId: string) {
  const buckets = ref<Map<string, number>>(new Map())
  const status = ref<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const lastEvent = ref<{ bucketName: string; tutorialTitle: string } | null>(null)

  const socket: Socket = io(`${baseUrl}/ws/event-stream`, {
    transports: ['websocket'],
  })

  socket.on('connect', () => {
    status.value = 'connected'
    socket.emit('enter', { context: eventId })
  })

  socket.on('disconnect', () => { status.value = 'disconnected' })
  socket.on('connect_error', () => { status.value = 'error' })

  socket.on('tutorialCompleted', (data) => {
    const count = buckets.value.get(data.bucketName) || 0
    buckets.value.set(data.bucketName, count + 1)
    lastEvent.value = { bucketName: data.bucketName, tutorialTitle: data.tutorialTitle }
  })

  onUnmounted(() => socket.disconnect())

  return { buckets, status, lastEvent }
}
```

### Impact on App.vue

Minimal — the composable API (`buckets`, `status`, `lastEvent`) is unchanged. All 8 rotating views, animations, and confetti continue working as-is.

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

  const socket: Socket = io(`${baseUrl}/ws/display`, {
    transports: ['websocket'],
    // Auth automatic — browser sends XSUAA cookie on HTTP upgrade
  })

  socket.on('connect', () => {
    connected.value = true
    socket.emit('enter', { context: eventId })
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

**Add (display-app):**
- `socket.io-client: ^4.x`

**Remove (display-app):**
- `@stomp/stompjs: ^7.3.0`

**Add (apps):**
- `socket.io-client: ^4.x`

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
| CREATE | `srv/event-stream-service.js` | Empty handler (just needs to exist for plugin) |
| CREATE | `apps/src/app-space/useRealtimeProgress.ts` | Socket.IO composable for AppSpace |
| CREATE | `apps/src/composables/useConfetti.ts` | Copied from display-app |
| MODIFY | `srv/display-service.cds` | Add `@protocol: ['odata','websocket']` + event |
| MODIFY | `srv/developer-service.js` | Replace `cds.broker.publish` with `srv.emit` |
| MODIFY | `srv/server.js` | Remove STOMP broker `cds.on('listening')` block |
| MODIFY | `display-app/src/event-stream.ts` | Rewrite: STOMP → Socket.IO |
| MODIFY | `display-app/package.json` | Swap @stomp/stompjs → socket.io-client |
| MODIFY | `apps/src/app-space/AppSpace.vue` | Add realtime watch + celebration effects |
| MODIFY | `apps/package.json` | Add socket.io-client |
| MODIFY | `package.json` (root) | Add plugin + socket.io, remove ws |
| DELETE | `srv/lib/stomp-broker.js` | Replaced by plugin |

## Testing

- **Unit tests:** Verify `srv.emit()` fires with correct payload and context after task record creation. Mock the WebSocket layer (plugin doesn't create servers during `cds.test()`).
- **Hybrid tests:** Unchanged — test data logic, not WebSocket transport.
- **Manual integration:** Connect `display-app` and `AppSpace` to local `cds watch`, create a task record, verify both receive the event.
- **Smoke tests:** Add a test verifying `/ws/event-stream` endpoint responds to Socket.IO handshake (HTTP 200 on polling transport).

## Migration Notes

- This is a breaking change for the WebSocket protocol (STOMP → Socket.IO). Both client apps must be deployed simultaneously with the backend.
- Demo mode in display-app remains unchanged (generates local fake data, no server connection).
- The `apps/src/event-display/EventDisplay.vue` component also uses STOMP via its own `useEventStream.ts` — it needs the same Socket.IO rewrite as display-app.
