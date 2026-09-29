# WebSocket scaling at N>1 srv — sticky sessions + Redis adapter (#2524)

**Status:** Design — awaiting review
**Date:** 2026-09-29
**Issue:** [sap-tutorials/tutorials-ims#2524](https://github.com/sap-tutorials/tutorials-ims/issues/2524)
**Target branch:** `DEV`

## Problem

`tutorials-srv` runs Socket.IO through the `@cap-js-community/websocket` plugin
(`cds.websocket.kind: "socket.io"`) on two namespaces:

- `/ws/display` — `DisplayService` (`srv/display-service.cds`), `@requires: 'DisplayApp'`
- `/ws/event-stream` — `EventStreamService` (`srv/event-stream-service.cds`), `@requires: 'any'`

On tutorial completion, `srv/developer-service.js:780-790` emits `tutorialCompleted`
to both services via `service.tx({ user: privileged }, tx => tx.emit(...))`, scoped
by `contexts: [String(event.legacyId)]`.

At `instances: 1` this works. `deploy/prod.mtaext` already sets `tutorials-srv
instances: 2`. **At N>1 srv there are two distinct, independent failure modes:**

### Failure mode 1 — cross-instance fan-out is lossy (the core bug)

Socket.IO connection state lives in the process memory of whichever srv instance
accepted the WebSocket. A `tx.emit('tutorialCompleted')` executing on instance A
only reaches sockets held by instance A. A display client parked on instance B
never sees it. There is no shared message bus between instances, so broadcasts are
**silently partial** — no error, just missed events. This is the bug the issue
reports.

### Failure mode 2 — handshake integrity across a multi-instance backend

The Socket.IO/engine.io handshake is multi-request (HTTP polling upgrade → WS). If
the polling requests in a single handshake are load-balanced across different srv
instances, the handshake fails or flaps, because engine.io session state for an
in-flight handshake is also per-instance. This needs request affinity for the
duration of a client's connection.

**Sticky sessions alone do NOT fix mode 1.** Affinity keeps a *client* pinned to one
instance, but the *emitter* (the instance running the completion transaction) can be
a different instance. Only a shared adapter fixes fan-out. Both fixes are required
and they address different layers — this is why the chosen scope is A+B, not either
alone.

## Chosen approach: A + B together

- **(A) Sticky sessions** — pin each client's connection to one srv instance for
  handshake integrity (mode 2).
- **(B) Shared Redis adapter** — bridge broadcasts across all srv instances so a
  completion on any instance reaches every subscribed client (mode 1).

Decided with Tom:
- Scope: **both (a)+(b)**.
- Sequencing: **block on the Redis entitlement first** — do A+B together against a
  real bound service. No dormant/unbound code. (Entitlement has since been added;
  `redis-cache` is in the marketplace with plans development/standard/premium.)
- Redis plan: **standard, in every environment** (DEV/QA/PROD).
- Verification: **full DEV fan-out test** — bind Redis on DEV, deploy A+B, and prove
  a completion emitted on one instance reaches a WS client on another, before opening
  the PR.

### How the plugin actually implements Redis (verified against installed 1.11.1)

Reading the installed plugin source rather than assuming:

- For `kind: "socket.io"`, `src/socket/socket.io.js#applyAdapter()` reads
  `cds.env.websocket.adapter`. When `adapter.impl === "@socket.io/redis-adapter"` it
  runs a Redis connection check, creates a primary + secondary client, and calls the
  **real** `@socket.io/redis-adapter`'s `createAdapter(pub, sub, options)`, then
  `io.adapter(...)`. So (B) is the genuine Socket.IO Redis adapter, not a bespoke
  bridge. `options.key` (default `"websocket"`) is the adapter's channel prefix.
- The Redis clients come from `@cap-js-community/common`'s `RedisClient`
  (`src/redis-client/RedisClient.js`). It resolves credentials from
  **`cds.env.requires["redis-websocket"]`** first (pattern `redis-${env}`, where the
  plugin instantiates `RedisClient.create("websocket")`), falling back to
  `cds.env.requires["redis"]`. That is what binds the adapter to a specific BTP
  service.
- Activation guard (`src/redis/index.js#connectionCheck`): active when
  `process.env.USER === "vcap"` (i.e. on CF) **or** `adapter.active === true`
  explicitly **or** `adapter.local === true`. Off-CF without an explicit flag it
  stays disabled and the server runs in-memory — so local `cds watch` and unit tests
  are unaffected with zero extra config.

**Dependency reality:** `@cap-js-community/common@0.5.0` and `redis@6.1.0` are
already installed (transitive via the websocket plugin). The **only** missing package
is `@socket.io/redis-adapter`, which the plugin `require`s by name at runtime.

## Rejected approaches

- **(c) Pin srv to 1** — the issue's last-resort option. Rejected: `prod.mtaext`
  already wants 2 instances; pinning to 1 caps the whole backend's throughput to
  protect one feature. Kicks the can.
- **Sticky sessions only (A alone)** — does not fix the core fan-out bug (mode 1).
  Rejected on correctness.
- **Redis adapter only (B alone)** — fixes fan-out but leaves the multi-request
  handshake vulnerable to cross-instance load-balancing (mode 2). The adapter shares
  *broadcasts*, not *handshake session state*. Rejected as incomplete.
- **A custom HANA-backed pub/sub bridge** (mirroring the rate-limiter "option 2"
  pattern) — reinvents what the plugin already does natively over Redis; adds DB write
  load on the hot completion path. Rejected.

## Precondition (satisfied)

Redis entitlement in the target subaccount(s). Was the hard blocker for (B); Tom has
added it. `redis-cache` now appears in the marketplace (plans development / standard /
premium). Plan chosen: **standard everywhere**.

## Components to change

### 1. CAP config — activate the Redis adapter (`package.json`)

Today `package.json` has (sibling of `cds.requires`, not under it):

```jsonc
"cds": {
  "websocket": { "kind": "socket.io" }
}
```

Change to add the adapter block, and add a `redis-websocket` requires entry so the
plugin's `RedisClient` finds the CF binding:

```jsonc
"cds": {
  "websocket": {
    "kind": "socket.io",
    "adapter": {
      "impl": "@socket.io/redis-adapter",
      "options": { "key": "socket.io" }
    }
  },
  "requires": {
    "redis-websocket": {
      "vcap": { "label": "redis-cache" }
    }
  }
}
```

- No `"active": true` in config: on CF `USER=vcap` auto-activates; off-CF it stays
  in-memory (desired — local/tests untouched).
- `vcap.label: "redis-cache"` binds by service label; the MTA gives the instance the
  name `tutorials-redis-websocket` (see §3). If label matching proves ambiguous at
  bind time we fall back to matching by instance name — resolved during the DEV
  deploy, noted as an open item.
- `options.key` is the **prefix for the Redis pub/sub channel names** the adapter
  broadcasts on (plugin default `"websocket"`). `tutorials-srv` uses `"socket.io"`;
  `tutorials-srv-qa` uses `"socket.io-qa"` so QA and primary can share one Redis
  instance without their broadcasts colliding (see §3).
- Add `@socket.io/redis-adapter` to `dependencies` (`npm install --save`). Use the
  current major, **v8.x** — that is the release line that pairs with `socket.io 4.x`
  (the adapter's major runs ahead of socket.io's; they are not meant to match
  numbers). Confirm the exact 8.x at install.

### 2. Sticky sessions — `srv/server.js` handshake cookie hook

CF's Gorouter provides session affinity when the app sets a `JSESSIONID` cookie
(alongside CF's own `__VCAP_ID__`). This is a **platform/Gorouter** mechanism, not an
`xs-app.json`/approuter config — `approuter/xs-app.json` already has
`websockets.enabled: true` and routes `/socket.io/*` and `/ws/*` through, which is all
it needs to do.

Set the cookie on the engine.io handshake only, via the plugin's `ws:ready` lifecycle
event (which exposes `cds.io`):

```js
cds.on('ws:ready', () => {
  cds.io?.engine?.on('initial_headers', (headers /*, req */) => {
    // Gorouter affinity: pin this client to this srv instance for the
    // lifetime of the Socket.IO connection. Scoped to the handshake; does
    // not touch application cookies.
    headers['set-cookie'] = [
      `JSESSIONID=${require('node:crypto').randomUUID()}; Path=/; HttpOnly; SameSite=Lax`,
    ];
  });
});
```

- Placed alongside the existing `cds.on('bootstrap')` (:228) / `cds.on('served')`
  (:1570) hooks.
- Affinity + adapter are complementary: affinity keeps a client's handshake on one
  instance; the adapter makes cross-instance emits arrive regardless.

### 3. MTA — provision + bind Redis (`.deploy/mta.yaml` + 3 mtaexts)

New managed-service resource, following the existing `tutorials-objectstore` pattern
(`.deploy/mta.yaml:497+`):

```yaml
- name: tutorials-redis-websocket
  type: org.cloudfoundry.managed-service
  parameters:
    service: redis-cache
    service-plan: standard
    service-name: tutorials-redis-websocket
```

Bind it to `tutorials-srv` (add to the module's `requires:` block, `.deploy/mta.yaml`
:157-163). `standard` plan in `.deploy/mta.yaml` base; confirm the resource is present
for each of `deploy/{dev,qa,prod}.mtaext` (standard everywhere → no per-env plan
override needed).

**`tutorials-srv-qa` — resolved: share one instance, distinct channel key.** The QA
module (`.deploy/mta.yaml:164`) also serves WebSocket and has the same fan-out bug at
N>1. QA binds to the **same** `tutorials-redis-websocket` instance rather than a
dedicated one — QA is low-traffic and a second managed Redis is unwarranted. Broadcast
isolation between QA and the primary is achieved by giving each module a distinct
adapter channel-key (see §1): primary uses `key: "socket.io"`, QA uses
`key: "socket.io-qa"`. Same Redis instance, non-colliding pub/sub channels. Hard
instance-level isolation is rejected — QA volume cannot swamp the shared instance.

### 4. Docs + stale comment

- `docs/developers/architecture/scaling-playbook.md` row #4 — mark resolved, record
  chosen path (A+B via plugin-native Redis adapter), link this PR.
- `srv/lib/content-cache-coherence.js:20` — comment claims "no pub/sub bus exists;
  websocket has no Redis adapter." After this change that is conditionally false (a
  Redis bus now exists for the websocket adapter). Update the comment; **do not** wire
  cache-coherence into Redis here — that is explicitly out of scope (see Scope
  boundaries).

## Data flow (after change, N=2 srv)

1. Client opens `/ws/display`; handshake polling requests all pinned to srv-A by
   `JSESSIONID` (A).
2. Client's socket lives on srv-A; subscribes to context `legacyId=123`.
3. A completion for tutorial 123 is processed on **srv-B**;
   `developer-service.js` emits `tutorialCompleted`.
4. Plugin's Socket.IO Redis adapter on srv-B publishes the broadcast to Redis
   (channel prefixed by `key: "socket.io"`).
5. srv-A's adapter, subscribed to the same channel, receives it and delivers to the
   local socket. Client sees the event. **Fan-out no longer lossy.**

## Error handling

- **No Redis binding present** (e.g. entitlement not yet propagated, local dev):
  `connectionCheck` returns false, adapter not mounted, server runs in-memory. No
  crash — same as today. This is why the local/test path needs no change.
- **Redis unreachable at runtime:** the `redis` client's reconnect handling applies;
  the plugin logs via `cds.log("websocket/redis")`. Worst case degrades to
  per-instance in-memory behavior (today's baseline) rather than failing requests.
- The completion emit path already wraps in try/catch (`developer-service.js:792`,
  `cds.log('ws').warn`), so an adapter hiccup never breaks the completion transaction.

## Testing plan

**Local (no Redis):**
- `npm test` — unit suite stays in-memory; assert no regression, adapter dormant.
- `test/smoke/websocket-handshake.test.js` — handshake still succeeds.

**DEV fan-out (gates the PR — the actual thing):**
1. `git fetch origin`; deploy A+B from fresh `origin/DEV` to DEV (Redis bound).
2. Scale `tutorials-srv` to 2 instances on DEV.
3. Connect a WS client to `/ws/display` for a given `legacyId`; confirm via
   `__VCAP_ID__`/logs which instance holds it.
4. Drive a completion for that `legacyId` and confirm (retry until observed on the
   *other* instance is exercised) the client receives `tutorialCompleted`.
5. `npm run loadtest:ws` (`test/load/scenarios/05-websocket-handshake.js`) at 2
   instances — handshake success rate stays green (proves sticky sessions).
6. Only after fan-out is demonstrably non-lossy: open the PR against DEV.

## Scope boundaries

**In scope:** activate the plugin's Redis adapter for the websocket namespaces; sticky
sessions; provision/bind `redis-cache` standard; docs/comment updates; DEV fan-out
verification.

**Out of scope (do NOT touch in this PR):**
- Wiring Redis into `content-cache-coherence.js` or any `srv/lib/*cache*` module
  (scaling-playbook row #5) — different problem, different PR.
- Replacing the in-process rate limiters with Redis (row #2) — even though `common`'s
  RedisClient could back them; not this change.
- Approuter auto-scaling (row #1) / cron separation (row #3).
- Changing emit sites or WS service definitions.

## Open items (resolve at implementation / DEV deploy)

1. **`vcap` binding resolution** — confirm `vcap.label: "redis-cache"` resolves the
   instance at deploy; fall back to instance-name match if needed. Verify during the
   DEV deploy.
2. **`@socket.io/redis-adapter` exact 8.x** — confirm the specific 8.x release at
   `npm install` (v8.x is the correct line for `socket.io 4.x`).

Resolved during review: QA shares one Redis instance with a distinct channel key
(`socket.io-qa`); `options.key` collision is thereby avoided (§3).
