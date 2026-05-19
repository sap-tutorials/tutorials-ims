# Joule Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Joule icon redirect with an embedded streaming AI chat backed by SAP AI Core, gated by a kill-switch admin setting and scoped strictly to SAP tutorial topics.

**Architecture:** A new `ChatSettings` singleton entity persisted in HANA governs both UI visibility (via a public projection) and backend acceptance. The Hugo header consults `/api/ChatConfig` to render the Joule button. A custom Express SSE endpoint registered on `cds.on('bootstrap')` accepts authenticated chat requests, builds a page-context-aware system prompt, and streams orchestration SDK output back to the browser. Conversation history lives only in `sessionStorage`; only metadata is logged.

**Tech Stack:** CAP Node.js, SAP AI Core via `@sap-ai-sdk/orchestration`, SAPUI5 Fiori Elements ObjectPage, Hugo, vanilla JS + `fetch` SSE reader, HANA Cloud, Vitest (unit/hybrid/smoke).

**Reference spec:** [`docs/superpowers/specs/2026-05-18-joule-chat-design.md`](../specs/2026-05-18-joule-chat-design.md)

**Project conventions to honor:**

- `srv/` and `test/` source files are **ESM** (the repo's `package.json` declares `"type": "module"`). Use `import`/`export`, not `require`/`module.exports`.
- Custom Express routes that need `cds.context.user` MUST be registered on `cds.on('served')` and chain `contextMw` + `authMw`. Routes registered on `cds.on('bootstrap')` run before CAP's auth middleware and will see `user` as undefined. Pattern: see `srv/server.js:92-114` (`/auth/user`).
- Vitest unit tests live at `test/<name>.test.js` (top-level), not in `test/unit/`. Hybrid tests live in `test/hybrid/`, smoke tests in `test/smoke/`.

---

## File Structure

**Created files:**

- `db/data/com.sap.developers.ims-ChatSettings.csv` — single seed row with `enabled=false`
- `srv/lib/chat-context.js` — page-kind → system prompt builder
- `srv/lib/chat-rate-limit.js` — in-memory rolling 24h counter
- `srv/lib/chat-orchestrator.js` — orchestration SDK wrapper, tool dispatch, SSE writer
- `srv/chat-service.cds` — `@path:'/chat'` service shell for ORD/audit registration
- `srv/chat-service.js` — no-op handler (the streaming endpoint lives in `server.js`)
- `app/admin/joule-settings/webapp/manifest.json` — Fiori Elements ObjectPage manifest (singleton)
- `app/admin/joule-settings/webapp/Component.js` — UI5 component shell
- `app/admin/joule-settings/webapp/index.html` — local dev entry
- `app/admin/joule-settings/webapp/i18n/i18n.properties` — labels
- `app/admin/joule-settings/package.json` — build wiring
- `app/admin/joule-settings/ui5.yaml` — UI5 tooling config
- `hugo/static/js/joule.js` — chat client (panel render, SSE reader, sessionStorage)
- `hugo/static/css/joule.css` — Joule panel styles (gradient diamond, dark-purple panel)
- `hugo/layouts/partials/joule-panel.html` — panel markup partial
- `test/chat-context.test.js`
- `test/chat-rate-limit.test.js`
- `test/chat-orchestrator.test.js`
- `test/chat-config-serve.test.js`
- `test/hybrid/chat-settings.test.js`
- `test/smoke/chat.test.js`

**Modified files:**

- `db/schema.cds` — append `ChatSettings` entity
- `db/persistence.cds` — append `@cds.persistence.journal` for ChatSettings
- `db/change-tracking.cds` — append `@changelog` for ChatSettings (create file if absent)
- `srv/admin-service.cds` — add `@odata.singleton` ChatSettings projection
- `srv/admin-service.js` — add `before READ` ensure-singleton handler
- `srv/developer-service.cds` — add public read-only `ChatConfig` projection
- `srv/server.js` — register `POST /chat/stream` Express route
- `app/admin-annotations.cds` — add `@UI` annotations for `ChatSettings`
- `app/admin-shell/webapp/manifest.json` — add `jouleSettingsComponent` usage + route + target
- `app/admin-shell/webapp/model/navigation.json` — add "Joule Chat" entry under `system`
- `app/admin-shell/package.json` — copy joule-settings dist into admin-shell during build
- `hugo/layouts/_default/baseof.html` — add `data-page-kind/slug/title/tags/step-count` attributes on `<html>`
- `hugo/layouts/partials/header.html` — replace existing `onclick` redirect; include joule-panel partial; add config-fetch script
- `.deploy/mta.yaml` — add `aicore` resource + `tutorials-srv` requires entry
- `package.json` (or `tutorials-srv` package.json if separate) — add `@sap-ai-sdk/orchestration` dependency

---

## Task 1: ChatSettings entity, persistence, and seed

**Files:**
- Modify: `db/schema.cds` (append at end)
- Modify: `db/persistence.cds` (append)
- Modify: `db/change-tracking.cds` (append; create if missing)
- Create: `db/data/com.sap.developers.ims-ChatSettings.csv`

- [ ] **Step 1: Append ChatSettings to `db/schema.cds`**

```cds
entity ChatSettings : cuid, managed {
  enabled              : Boolean default false;
  deploymentId         : String(100);
  maxRequestsPerUser   : Integer default 100;
  bannerText           : String(500);
}
```

- [ ] **Step 2: Append journal annotation to `db/persistence.cds`**

```cds
annotate ims.ChatSettings with @cds.persistence.journal;
```

- [ ] **Step 3: Append change-tracking annotation to `db/change-tracking.cds`**

If the file does not exist, create it with `using { com.sap.developers.ims as ims } from './schema';` at the top, then add:

```cds
annotate ims.ChatSettings with @changelog;
```

- [ ] **Step 4: Create the seed CSV `db/data/com.sap.developers.ims-ChatSettings.csv`**

```csv
ID;enabled;deploymentId;maxRequestsPerUser;bannerText
00000000-0000-0000-0000-00000000c8a7;false;;100;
```

The single fixed UUID is the canonical singleton row ID; treat it as a sentinel — no other code generates new ChatSettings rows.

- [ ] **Step 5: Compile sanity-check**

Run: `npx cds compile srv/ -o ./gen --to edmx 2>&1 | head -40`
Expected: no errors. Confirm `ChatSettings` appears in the compiled EDMX of AdminService after Task 2 — for now we just want a clean compile.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/persistence.cds db/change-tracking.cds db/data/com.sap.developers.ims-ChatSettings.csv
git commit -m "feat(chat): add ChatSettings entity with seed and journal/changelog annotations"
```

---

## Task 2: Singleton projection on AdminService + ensure-row handler

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Add the singleton projection to `srv/admin-service.cds`**

Inside the `service AdminService { ... }` block, add:

```cds
  @odata.singleton
  @requires: 'Admin'
  entity ChatSettings as projection on ims.ChatSettings;
```

- [ ] **Step 2: Add `before READ` ensure-singleton handler in `srv/admin-service.js`**

Inside the service implementation, register:

```js
const SINGLETON_ID = '00000000-0000-0000-0000-00000000c8a7';

this.before('READ', 'ChatSettings', async () => {
  const exists = await SELECT.one.from('com.sap.developers.ims.ChatSettings').where({ ID: SINGLETON_ID });
  if (!exists) {
    await INSERT.into('com.sap.developers.ims.ChatSettings').entries({
      ID: SINGLETON_ID,
      enabled: false,
      maxRequestsPerUser: 100
    });
  }
});
```

This is defensive — the seed CSV already populates the row on `cds deploy`. The handler covers fresh in-memory test databases.

- [ ] **Step 3: Add @UI annotations for the ObjectPage in `app/admin-annotations.cds`**

```cds
using AdminService from '../srv/admin-service';

annotate AdminService.ChatSettings with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'Joule Chat Settings',
      TypeNamePlural : 'Joule Chat Settings',
      Title          : { Value: bannerText }
    },
    Facets: [{
      $Type  : 'UI.ReferenceFacet',
      Label  : 'General',
      Target : '@UI.FieldGroup#General'
    }],
    FieldGroup #General: {
      Data: [
        { Value: enabled },
        { Value: deploymentId },
        { Value: maxRequestsPerUser },
        { Value: bannerText }
      ]
    }
  }
) {
  enabled            @title: 'Enabled' @description: 'Master kill-switch. When off, the Joule button is hidden and /chat/stream returns 503.';
  deploymentId       @title: 'AI Core Deployment ID' @description: 'Orchestration deployment from SAP AI Core Generative AI Hub.';
  maxRequestsPerUser @title: 'Max Requests / User / Day' @description: 'In-memory rolling 24h limit, per service instance. Effective ceiling = this × instance count.';
  bannerText         @title: 'Banner Text'   @description: 'Optional notice shown above the chat input (e.g. "Joule is in beta").' @UI.MultiLineText;
};
```

- [ ] **Step 4: Compile and verify projection is exposed**

Run: `npx cds compile srv/admin-service.cds --to edmx | grep -i ChatSettings`
Expected: ChatSettings entity present in the AdminService EDMX with `@odata.singleton`.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds
git commit -m "feat(chat): expose ChatSettings as admin singleton with @UI annotations"
```

---

## Task 3: Public ChatConfig projection on DeveloperService

**Files:**
- Modify: `srv/developer-service.cds`
- Create: `test/chat-config-serve.test.js`

- [ ] **Step 1: Write the failing test `test/chat-config-serve.test.js`**

```js
import cds from '@sap/cds';
import { describe, it, expect } from 'vitest';

const { GET } = cds.test(import.meta.dirname + '/..');

describe('GET /api/ChatConfig', () => {
  it('returns enabled and bannerText only', async () => {
    const { data, status } = await GET('/api/ChatConfig');
    expect(status).toBe(200);
    expect(data).toHaveProperty('enabled');
    expect(data).toHaveProperty('bannerText');
    expect(data).not.toHaveProperty('deploymentId');
    expect(data).not.toHaveProperty('maxRequestsPerUser');
  });

  it('is reachable without auth', async () => {
    const { status } = await GET('/api/ChatConfig');
    expect(status).toBe(200);
  });
});
```

If sibling tests in `test/` use a different harness (e.g. `cds.test(...)` with a different relative path or named imports), mirror that exactly — open `test/developer-service.test.js` for the canonical pattern.

- [ ] **Step 2: Run the test to confirm failure**

Run: `npx vitest run test/chat-config-serve.test.js`
Expected: FAIL — endpoint not found.

- [ ] **Step 3: Add the public projection to `srv/developer-service.cds`**

Inside `service DeveloperService { ... }` (the existing service at `@path: '/api'`):

```cds
  @requires: 'any'
  @readonly
  entity ChatConfig as projection on ims.ChatSettings { enabled, bannerText };
```

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run test/chat-config-serve.test.js`
Expected: PASS — both assertions hold; `deploymentId` and `maxRequestsPerUser` are NOT projected.

- [ ] **Step 5: Commit**

```bash
git add srv/developer-service.cds test/chat-config-serve.test.js
git commit -m "feat(chat): public ChatConfig projection (enabled + bannerText only)"
```

---

## Task 4: System prompt builder with unit tests

**Files:**
- Create: `srv/lib/chat-context.js`
- Create: `test/chat-context.test.js`

- [ ] **Step 1: Write the failing test `test/chat-context.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt', () => {
  const user = { firstName: 'Tom', lastName: 'Jung' };

  it('always includes the Joule persona and scope guard', () => {
    const out = buildSystemPrompt({ kind: 'generic' }, user);
    expect(out).toMatch(/You are Joule/);
    expect(out).toMatch(/SAP tutorials/);
  });

  it('injects tutorial details for kind=tutorial', () => {
    const out = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Build with CAP',
      description: 'Hands-on intro',
      tags: ['cap', 'nodejs'],
      stepCount: 7,
      currentStep: 3
    }, user);
    expect(out).toMatch(/Build with CAP/);
    expect(out).toMatch(/step 3/i);
    expect(out).toMatch(/cap, nodejs/);
  });

  it('directs the model to call searchTutorials first on kind=search', () => {
    const out = buildSystemPrompt({ kind: 'search', query: 'hana', filters: ['hana'] }, user);
    expect(out).toMatch(/searchTutorials/);
    expect(out).toMatch(/hana/);
  });

  it('lists contained tutorials for mission/group', () => {
    const out = buildSystemPrompt({
      kind: 'mission',
      title: 'Become a CAP dev',
      tutorials: [{ title: 'A' }, { title: 'B' }]
    }, user);
    expect(out).toMatch(/Become a CAP dev/);
    expect(out).toMatch(/A.*B/s);
  });

  it('omits the user name when no user is supplied', () => {
    const out = buildSystemPrompt({ kind: 'generic' }, null);
    expect(out).not.toMatch(/Tom/);
  });

  it('handles missing optional tutorial fields gracefully', () => {
    expect(() => buildSystemPrompt({ kind: 'tutorial', title: 'X' }, user)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `npx vitest run test/chat-context.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/lib/chat-context.js`**

```js
const PERSONA = `You are Joule, an AI assistant embedded in the SAP Tutorial Platform. You ONLY answer questions about SAP tutorials and directly related topics (SAP technologies, the tutorial content, how to complete a step). If asked about anything else, politely redirect: "I can only help with SAP tutorials. Want me to find one about <topic>?". Never invent tutorial slugs, step numbers, or URLs. If you don't know, call the searchTutorials tool or say so.`;

function tutorialLayer(ctx) {
  const lines = [`Current page: tutorial "${ctx.title || 'unknown'}".`];
  if (ctx.description) lines.push(`Description: ${ctx.description}`);
  if (Array.isArray(ctx.tags) && ctx.tags.length) lines.push(`Tags: ${ctx.tags.join(', ')}`);
  if (ctx.stepCount) lines.push(`Total steps: ${ctx.stepCount}.`);
  if (ctx.currentStep) lines.push(`User is currently on step ${ctx.currentStep}.`);
  lines.push('Prefer answering about THIS tutorial; cite step numbers. Only call searchTutorials if the user asks about a different tutorial.');
  return lines.join('\n');
}

function searchLayer(ctx) {
  const lines = ['Current page: tutorial search.'];
  if (ctx.query) lines.push(`Active query: "${ctx.query}"`);
  if (Array.isArray(ctx.filters) && ctx.filters.length) lines.push(`Active filters: ${ctx.filters.join(', ')}`);
  lines.push('Always call searchTutorials first; summarize 1–3 best matches with slug + a one-line reason.');
  return lines.join('\n');
}

function collectionLayer(ctx, kindLabel) {
  const lines = [`Current page: ${kindLabel} "${ctx.title || 'unknown'}".`];
  if (Array.isArray(ctx.tutorials) && ctx.tutorials.length) {
    const list = ctx.tutorials.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    lines.push(`Contained tutorials:\n${list}`);
  }
  lines.push(`Explain the path, prerequisites, and suggest the next logical tutorial.`);
  return lines.join('\n');
}

function pageLayer(pageContext) {
  switch (pageContext?.kind) {
    case 'tutorial': return tutorialLayer(pageContext);
    case 'search':   return searchLayer(pageContext);
    case 'mission':  return collectionLayer(pageContext, 'mission');
    case 'group':    return collectionLayer(pageContext, 'group');
    default:         return 'Use searchTutorials liberally to ground answers.';
  }
}

function userLayer(user) {
  if (!user || !user.firstName) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return `The user's name is ${name}. Use it sparingly.`;
}

export function buildSystemPrompt(pageContext, user) {
  return [PERSONA, pageLayer(pageContext), userLayer(user)].filter(Boolean).join('\n\n');
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run test/chat-context.test.js`
Expected: PASS — all six tests green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/chat-context.js test/chat-context.test.js
git commit -m "feat(chat): system-prompt builder with page-kind specializations"
```

---

## Task 5: In-memory rate limiter with unit tests

**Files:**
- Create: `srv/lib/chat-rate-limit.js`
- Create: `test/chat-rate-limit.test.js`

- [ ] **Step 1: Write the failing test `test/chat-rate-limit.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../srv/lib/chat-rate-limit.js';

describe('chat-rate-limit', () => {
  it('allows up to the limit then throws RateLimitError', () => {
    const rl = createRateLimiter();
    for (let i = 0; i < 3; i++) rl.check('user-a', 3);
    expect(() => rl.check('user-a', 3)).toThrow(/rate/i);
  });

  it('isolates counters per user', () => {
    const rl = createRateLimiter();
    rl.check('a', 1);
    expect(() => rl.check('a', 1)).toThrow();
    expect(() => rl.check('b', 1)).not.toThrow();
  });

  it('resets after the window expires', () => {
    let now = 1_000_000;
    const rl = createRateLimiter({ now: () => now });
    rl.check('a', 1);
    expect(() => rl.check('a', 1)).toThrow();
    now += 24 * 60 * 60 * 1000 + 1;
    expect(() => rl.check('a', 1)).not.toThrow();
  });

  it('reads the limit fresh on each call', () => {
    const rl = createRateLimiter();
    rl.check('a', 1);
    expect(() => rl.check('a', 5)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `npx vitest run test/chat-rate-limit.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/lib/chat-rate-limit.js`**

```js
const WINDOW_MS = 24 * 60 * 60 * 1000;

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super('rate_limit');
    this.code = 'RATE_LIMIT';
    this.retryAfterSec = retryAfterSec;
  }
}

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const counters = new Map();

  return {
    check(userId, limit) {
      const t = now();
      let entry = counters.get(userId);
      if (!entry || t - entry.windowStart >= WINDOW_MS) {
        entry = { count: 0, windowStart: t };
        counters.set(userId, entry);
      }
      if (entry.count >= limit) {
        const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - t) / 1000);
        throw new RateLimitError(retryAfterSec);
      }
      entry.count += 1;
    }
  };
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `npx vitest run test/chat-rate-limit.test.js`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/chat-rate-limit.js test/chat-rate-limit.test.js
git commit -m "feat(chat): in-memory rolling 24h rate limiter"
```

---

## Task 6: Chat orchestrator with mocked SDK + tool-dispatch agent loop

**Files:**
- Create: `srv/lib/chat-orchestrator.js`
- Create: `test/chat-orchestrator.test.js`
- Modify: `package.json` (add `@sap-ai-sdk/orchestration`)

**Why an explicit agent loop:** `@sap-ai-sdk/orchestration` returns tool-call requests in the model's response — it does NOT auto-invoke local callbacks. Implementing RAG end-to-end requires:
1. Stream the first model turn.
2. If the assistant emits a tool call, suspend streaming, run `dispatchTool(name, args)` locally.
3. Append `{ role: 'assistant', tool_calls: [...] }` and `{ role: 'tool', tool_call_id, content: JSON.stringify(result) }` to the message history.
4. Re-invoke `client.stream` with the augmented history; repeat until no tool calls remain or a max-turn safety cap is hit.

This is the canonical OpenAI-style function-calling loop and is what the SDK expects callers to implement.

- [ ] **Step 1: Add the dependency**

Run: `npm install @sap-ai-sdk/orchestration`
Verify it appears in `package.json` dependencies. Per global rule, the package must be public on npmjs.com — `@sap-ai-sdk/orchestration` is.

- [ ] **Step 2: Write the failing test `test/chat-orchestrator.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamMock = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(() => ({ stream: streamMock }))
}));

const connectMock = vi.fn();
vi.mock('@sap/cds', () => ({
  default: {
    log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
    connect: { to: connectMock }
  }
}));

const { streamChat, dispatchTool } = await import('../srv/lib/chat-orchestrator.js');

function fakeRes() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(String(s)); },
    end() { this.ended = true; }
  };
}

function makeStream(events) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

describe('chat-orchestrator', () => {
  beforeEach(() => {
    streamMock.mockReset();
    connectMock.mockReset();
  });

  it('emits delta SSE events and a done event for plain text', async () => {
    streamMock.mockReturnValueOnce(makeStream([
      { getDeltaContent: () => 'Hel', getToolCalls: () => null },
      { getDeltaContent: () => 'lo', getToolCalls: () => null }
    ]));
    const res = fakeRes();
    await streamChat({
      res, system: 'sys', messages: [{ role: 'user', content: 'hi' }], deploymentId: 'd1'
    });
    const joined = res.chunks.join('');
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"Hel"/);
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"lo"/);
    expect(joined).toMatch(/"type":"done"/);
    expect(res.ended).toBe(true);
  });

  it('runs the searchTutorials tool and re-invokes the model with results', async () => {
    const searchRun = vi.fn().mockResolvedValue([{ slug: 'a', title: 'A', type: 'tutorial' }]);
    connectMock.mockResolvedValue({ run: searchRun });

    // First turn: model requests a tool call
    streamMock.mockReturnValueOnce(makeStream([
      {
        getDeltaContent: () => null,
        getToolCalls: () => [{ id: 't1', name: 'searchTutorials', args: { query: 'cap' } }]
      }
    ]));
    // Second turn: model produces final text
    streamMock.mockReturnValueOnce(makeStream([
      { getDeltaContent: () => 'Found it', getToolCalls: () => null }
    ]));

    const res = fakeRes();
    await streamChat({
      res, system: 's', messages: [{ role: 'user', content: 'find cap' }], deploymentId: 'd1'
    });

    expect(searchRun).toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(2);
    const joined = res.chunks.join('');
    expect(joined).toMatch(/"type":"tool"[^}]*"name":"searchTutorials"/);
    expect(joined).toMatch(/"type":"delta"[^}]*"content":"Found it"/);
    expect(joined).toMatch(/"type":"done"/);
  });

  it('dispatchTool returns shaped hits from SearchService', async () => {
    const searchRun = vi.fn().mockResolvedValue([
      { slug: 'a', title: 'A', description: 'd', type: 'tutorial', primaryTag: 'cap' }
    ]);
    connectMock.mockResolvedValue({ run: searchRun });
    const result = await dispatchTool('searchTutorials', { query: 'cap', tags: ['cap'] });
    expect(searchRun).toHaveBeenCalled();
    expect(result).toEqual([
      { slug: 'a', title: 'A', description: 'd', type: 'tutorial', primaryTag: 'cap' }
    ]);
  });

  it('dispatchTool returns search_failed shape on error', async () => {
    connectMock.mockRejectedValue(new Error('boom'));
    const result = await dispatchTool('searchTutorials', { query: 'x' });
    expect(result).toEqual({ error: 'search_failed', hits: [] });
  });

  it('emits an error SSE event when the SDK throws', async () => {
    streamMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [], deploymentId: 'd1' });
    expect(res.chunks.join('')).toMatch(/"type":"error"/);
    expect(res.ended).toBe(true);
  });

  it('caps the agent loop to prevent infinite tool recursion', async () => {
    connectMock.mockResolvedValue({ run: vi.fn().mockResolvedValue([]) });
    // Every turn keeps requesting a tool
    streamMock.mockReturnValue(makeStream([
      { getDeltaContent: () => null, getToolCalls: () => [{ id: 'x', name: 'searchTutorials', args: { query: 'q' } }] }
    ]));
    const res = fakeRes();
    await streamChat({ res, system: 's', messages: [{ role: 'user', content: 'q' }], deploymentId: 'd1' });
    // Should have stopped after MAX_TURNS — not infinite
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res.ended).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to confirm failure**

Run: `npx vitest run test/chat-orchestrator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `srv/lib/chat-orchestrator.js`**

```js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';

const LOG = cds.log('chat');
const MAX_TURNS = 5;

const SEARCH_TUTORIALS_TOOL = {
  type: 'function',
  function: {
    name: 'searchTutorials',
    description: 'Search the SAP tutorial catalog. Use when the user asks to find a tutorial or needs context from a tutorial other than the current one.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords to search' },
        tags:  { type: 'array',  items: { type: 'string' }, description: 'optional tag filters' },
        type:  { type: 'string', enum: ['tutorial', 'mission', 'group'], description: 'optional kind filter' }
      },
      required: ['query']
    }
  }
};

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function dispatchTool(name, args) {
  if (name !== 'searchTutorials') return { error: 'unknown_tool' };
  try {
    const search = await cds.connect.to('SearchService');
    const filters = {};
    if (Array.isArray(args.tags) && args.tags.length) filters.tags = args.tags;
    if (args.type) filters.type = args.type;
    const hits = await search.run(SELECT.from('SearchableItems')
      .where({ search: args.query, ...filters })
      .limit(5));
    return (hits || []).map(h => ({
      slug: h.slug, title: h.title, description: h.description,
      type: h.type, primaryTag: h.primaryTag
    }));
  } catch (err) {
    LOG.warn('searchTutorials failed', err.message);
    return { error: 'search_failed', hits: [] };
  }
}

export async function streamChat({ res, system, messages, deploymentId }) {
  const client = new OrchestrationClient({
    llm: { deploymentId },
    templating: { template: [{ role: 'system', content: system }] },
    tools: [SEARCH_TUTORIALS_TOOL]
  });

  const history = [...messages];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.stream({ messagesHistory: history });
      const collectedToolCalls = [];
      let assistantText = '';

      for await (const chunk of stream) {
        const delta = typeof chunk.getDeltaContent === 'function' ? chunk.getDeltaContent() : null;
        if (delta) {
          assistantText += delta;
          sse(res, { type: 'delta', content: delta });
        }
        const toolCalls = typeof chunk.getToolCalls === 'function' ? chunk.getToolCalls() : null;
        if (Array.isArray(toolCalls) && toolCalls.length) {
          for (const tc of toolCalls) {
            collectedToolCalls.push(tc);
            sse(res, { type: 'tool', name: tc.name, args: tc.args });
          }
        }
      }

      if (collectedToolCalls.length === 0) {
        // Final turn — model produced text only
        sse(res, { type: 'done' });
        return;
      }

      // Append the assistant's tool-call request, then run each tool and append its result
      history.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: collectedToolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }))
      });

      for (const tc of collectedToolCalls) {
        const result = await dispatchTool(tc.name, tc.args || {});
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Hit the safety cap — finish the stream cleanly
    LOG.warn('chat agent loop hit MAX_TURNS', { turns: MAX_TURNS });
    sse(res, { type: 'done' });
  } catch (err) {
    const reason = err?.code === 'CONTENT_FILTER' ? 'content_filter' : undefined;
    sse(res, { type: 'error', retryable: !reason, reason });
    LOG.error('chat stream failed', err.message);
  } finally {
    res.end();
  }
}

export { SEARCH_TUTORIALS_TOOL };
```

- [ ] **Step 5: Run the test to confirm pass**

Run: `npx vitest run test/chat-orchestrator.test.js`
Expected: PASS — all six tests green (delta-only, tool-then-text, dispatch happy path, dispatch failure shape, SDK error, max-turns cap).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator.test.js package.json package-lock.json
git commit -m "feat(chat): orchestrator wrapping @sap-ai-sdk/orchestration with tool-dispatch agent loop"
```

---

## Task 7: Chat service shell + SSE Express endpoint

**Files:**
- Create: `srv/chat-service.cds`
- Create: `srv/chat-service.js`
- Modify: `srv/server.js`

- [ ] **Step 1: Create the service shell `srv/chat-service.cds`**

```cds
@path: '/chat'
@requires: 'authenticated-user'
service ChatService {
  // No entities or actions — the streaming endpoint is a custom Express route on /chat/stream.
  // This service exists for ORD/audit registration symmetry with other services.
}
```

- [ ] **Step 2: Create the no-op handler `srv/chat-service.js` (ESM)**

```js
import cds from '@sap/cds';

export default class ChatService extends cds.ApplicationService {
  async init() {
    // intentionally empty — the streaming hot path is a custom Express route
    // registered in srv/server.js. This class exists so CAP wires up ORD/audit
    // metadata symmetrically with the other services.
    return super.init();
  }
}
```

- [ ] **Step 3: Register the SSE endpoint in `srv/server.js` on the served lifecycle**

> **Why `served`, not `bootstrap`:** `cds.context.user` is only populated by the auth middleware chain, which is wired during the served phase. Routes added in `bootstrap` run before any auth middleware, so `cds.context?.user` is `undefined` there. The pattern below mirrors the existing `/auth/user` route at [srv/server.js](../../../srv/server.js) (around the `cds.on('served')` block) — chain `contextMw` then `authMw` so the same XSUAA logic that protects OData services also protects the SSE endpoint.

ESM imports go at the top of `srv/server.js` (the file already uses `import cds from '@sap/cds'`):

```js
import express from 'express';
import { buildSystemPrompt } from './lib/chat-context.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { streamChat } from './lib/chat-orchestrator.js';
```

Then add a new served-phase block (alongside the existing `cds.on('served', ...)` blocks — do NOT add to `cds.on('bootstrap')`):

```js
cds.on('served', () => {
  const app = cds.app;
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());

  const rateLimiter = createRateLimiter();
  const SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

  app.post(
    '/chat/stream',
    express.json({ limit: '64kb' }),
    contextMw,
    authMw,
    async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // 1) Kill switch — read fresh on every request via cds.ql
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      let settings;
      try {
        settings = await SELECT.one.from(ChatSettings).where({ ID: SETTINGS_ID });
      } catch (err) {
        cds.log('chat').warn('ChatSettings read failed; treating as disabled', err);
        res.status(503).end(JSON.stringify({ error: 'disabled' }));
        return;
      }
      if (!settings || !settings.enabled || !settings.deploymentId) {
        res.status(503).end(JSON.stringify({ error: 'disabled' }));
        return;
      }

      // 2) Auth — cds.context.user is populated by authMw above. Mirror the
      // canonical anonymous check at srv/server.js (the /auth/user route).
      const user = cds.context?.user;
      if (!user?.id || user.id === 'anonymous') {
        res.status(401).end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }

      // 3) Rate limit
      try {
        rateLimiter.check(user.id, settings.maxRequestsPerUser ?? 100);
      } catch (err) {
        if (err instanceof RateLimitError) {
          res.status(429).end(JSON.stringify({ error: 'rate_limit', retryAfter: err.retryAfterSec }));
          return;
        }
        throw err;
      }

      // 4) System prompt + stream
      const { messages = [], pageContext = { kind: 'generic' } } = req.body || {};
      const system = buildSystemPrompt(pageContext, {
        firstName: user.attr?.firstName || user.firstName,
        lastName:  user.attr?.lastName  || user.lastName
      });

      await streamChat({
        res,
        system,
        messages,
        deploymentId: settings.deploymentId
      });
    }
  );

  cds.log('chat').info('POST /chat/stream registered');
});
```

- [ ] **Step 4: Verify the route mounts cleanly**

Run: `npm run watch 2>&1 | head -40`
Expected: server boots without errors and the line `POST /chat/stream registered` appears in the logs. Stop the server with Ctrl+C.

To confirm auth gating, with the server running in another terminal:

```bash
curl -i -X POST http://localhost:4004/chat/stream -H 'Content-Type: application/json' -d '{}'
```
Expected: `HTTP/1.1 401` (no JWT). The 503 path requires `enabled=true` first; we cover both in smoke tests.

- [ ] **Step 5: Commit**

```bash
git add srv/chat-service.cds srv/chat-service.js srv/server.js
git commit -m "feat(chat): SSE /chat/stream endpoint with kill-switch + rate-limit gates"
```

---

## Task 8: Hugo header changes, Joule panel, and joule.js

**Files:**
- Modify: `hugo/layouts/_default/baseof.html`
- Modify: `hugo/layouts/partials/header.html`
- Create: `hugo/layouts/partials/joule-panel.html`
- Create: `hugo/static/js/joule.js`
- Create: `hugo/static/css/joule.css`

- [ ] **Step 1: Add page-context data attributes in `hugo/layouts/_default/baseof.html`**

Replace the existing `<html …>` open tag with:

```html
<html lang="{{ site.Language.Lang }}"
  data-cap-base="{{ site.Params.capBaseUrl | default "" }}"
  data-page-kind="{{ if .IsHome }}search{{ else if eq .Type "tutorials" }}tutorial{{ else if eq .Type "missions" }}mission{{ else if eq .Type "groups" }}group{{ else }}generic{{ end }}"
  data-page-slug="{{ .Params.slug }}"
  data-page-title="{{ .Title }}"
  data-page-tags="{{ delimit .Params.tags "," }}"
  data-page-step-count="{{ .Params.stepCount }}">
```

If your existing `<html>` tag has different attributes, preserve them; only add the `data-page-*` ones. Verify by `grep -n "<html" hugo/layouts/_default/baseof.html`.

- [ ] **Step 2: Replace the Joule button onclick in `hugo/layouts/partials/header.html`**

The existing element on line 23 has `onclick="window.open('https://sap-samples.github.io/sap-devs-cli/','_blank')"`. Replace that attribute with `id="joule-trigger" hidden`. Then, just before `</body>` in `baseof.html`, include the panel and script:

```html
{{ partial "joule-panel.html" . }}
<link rel="stylesheet" href="/css/joule.css">
<script src="/js/joule.js" defer></script>
```

- [ ] **Step 3: Create `hugo/layouts/partials/joule-panel.html`**

```html
<div id="joule-panel" hidden role="dialog" aria-label="Joule chat" aria-modal="false">
  <header class="joule-panel__header">
    <span class="joule-panel__diamond" aria-hidden="true"></span>
    <h2 class="joule-panel__title">Joule</h2>
    <button type="button" class="joule-panel__close" aria-label="Close Joule">×</button>
  </header>
  <div class="joule-panel__banner" hidden></div>
  <div class="joule-panel__transcript" aria-live="polite"></div>
  <form class="joule-panel__form" autocomplete="off">
    <input type="text" class="joule-panel__input" placeholder="Ask about SAP tutorials…" aria-label="Message Joule" />
    <button type="submit" class="joule-panel__send" aria-label="Send">Send</button>
  </form>
</div>
```

- [ ] **Step 4: Create `hugo/static/css/joule.css`**

```css
#joule-panel {
  position: fixed; top: 4rem; right: 1rem;
  width: min(420px, calc(100vw - 2rem));
  height: min(640px, calc(100vh - 5rem));
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, #2b1c4e 0%, #1a0f33 100%);
  color: #f5f5fb; border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,.4);
  z-index: 9000;
}
.joule-panel__header { display:flex; align-items:center; gap:.5rem; padding:1rem; }
.joule-panel__title  { font-size:1rem; font-weight:600; flex:1; margin:0; }
.joule-panel__close  { background:none; border:0; color:inherit; font-size:1.4rem; cursor:pointer; }
.joule-panel__diamond {
  width:24px; height:24px; transform: rotate(45deg);
  background: linear-gradient(135deg,#7e57ff,#3aa6ff);
  border-radius:4px;
}
.joule-panel__diamond.is-loading { animation: jouleSpin 1.4s linear infinite; }
@keyframes jouleSpin { to { transform: rotate(405deg); } }
.joule-panel__banner { padding:0 1rem .5rem; font-size:.85rem; opacity:.85; }
.joule-panel__transcript { flex:1; overflow-y:auto; padding:0 1rem 1rem; }
.joule-msg { margin: .5rem 0; padding:.6rem .8rem; border-radius:12px; max-width:85%; line-height:1.4; }
.joule-msg--user { margin-left:auto; background:#3a2864; }
.joule-msg--assistant { background:#1f1442; }
.joule-msg--error { background:#5b1f1f; }
.joule-tool-chip { display:inline-block; font-size:.75rem; padding:.15rem .5rem; border-radius:999px; background:#0e3a5a; }
.joule-greeting { padding:1.5rem 1rem; text-align:center; }
.joule-panel__form { display:flex; gap:.5rem; padding:1rem; border-top:1px solid rgba(255,255,255,.1); }
.joule-panel__input { flex:1; padding:.6rem .8rem; border-radius:8px; border:0; background:#0f0825; color:#fff; }
.joule-panel__send  { padding:.6rem 1rem; border-radius:8px; border:0; background:#7e57ff; color:#fff; cursor:pointer; }
```

- [ ] **Step 5: Create `hugo/static/js/joule.js`**

```js
(function () {
  'use strict';

  const CONFIG_KEY = 'joule.config.v1';
  const HISTORY_KEY = 'joule.history';
  const CONFIG_TTL_MS = 60_000;

  const trigger = document.getElementById('joule-trigger');
  const panel = document.getElementById('joule-panel');
  if (!trigger || !panel) return;

  const transcript = panel.querySelector('.joule-panel__transcript');
  const banner = panel.querySelector('.joule-panel__banner');
  const form = panel.querySelector('.joule-panel__form');
  const input = panel.querySelector('.joule-panel__input');
  const closeBtn = panel.querySelector('.joule-panel__close');

  function getCachedConfig() {
    try {
      const raw = sessionStorage.getItem(CONFIG_KEY);
      if (!raw) return null;
      const { ts, value } = JSON.parse(raw);
      if (Date.now() - ts > CONFIG_TTL_MS) return null;
      return value;
    } catch { return null; }
  }

  async function loadConfig() {
    const cached = getCachedConfig();
    if (cached) return cached;
    try {
      const r = await fetch('/api/ChatConfig', { credentials: 'include' });
      if (!r.ok) return { enabled: false };
      const cfg = await r.json();
      sessionStorage.setItem(CONFIG_KEY, JSON.stringify({ ts: Date.now(), value: cfg }));
      return cfg;
    } catch { return { enabled: false }; }
  }

  function loadHistory() {
    try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  }
  function saveHistory(messages) {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(messages));
  }

  function escapeText(s) {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
  }

  function appendMessage(role, content, opts = {}) {
    const div = document.createElement('div');
    div.className = `joule-msg joule-msg--${role}`;
    div.textContent = content;
    if (opts.id) div.dataset.id = opts.id;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
    return div;
  }

  function renderGreeting(firstName) {
    transcript.replaceChildren();
    const div = document.createElement('div');
    div.className = 'joule-greeting';
    div.textContent = firstName
      ? `Hello ${firstName}, How can I help you?`
      : 'Hello, How can I help you?';
    transcript.appendChild(div);
  }

  function renderTranscript(messages) {
    transcript.replaceChildren();
    for (const m of messages) appendMessage(m.role, m.content);
  }

  function readPageContext() {
    const html = document.documentElement;
    const ctx = {
      kind: html.dataset.pageKind || 'generic',
      slug: html.dataset.pageSlug || undefined,
      title: html.dataset.pageTitle || undefined,
      tags: (html.dataset.pageTags || '').split(',').map(s => s.trim()).filter(Boolean),
      stepCount: html.dataset.pageStepCount ? Number(html.dataset.pageStepCount) : undefined
    };
    if (ctx.kind === 'search') {
      const params = new URLSearchParams(location.search);
      ctx.query = params.get('q') || undefined;
      ctx.filters = Array.from(document.querySelectorAll('input[name="facet"]:checked')).map(el => el.value);
    }
    if (ctx.kind === 'tutorial') {
      const active = document.querySelector('[data-step-active="true"]');
      if (active) ctx.currentStep = Number(active.dataset.stepNumber);
    }
    return ctx;
  }

  function readUser() {
    try { return JSON.parse(document.documentElement.dataset.user || 'null'); } catch { return null; }
  }

  async function send(messageText) {
    const messages = loadHistory();
    messages.push({ role: 'user', content: messageText });
    renderTranscript(messages);
    saveHistory(messages);

    const assistantBubble = appendMessage('assistant', '');
    let assistantText = '';

    let res;
    try {
      res = await fetch('/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, pageContext: readPageContext() })
      });
    } catch {
      assistantBubble.textContent = 'Network error. Please try again.';
      assistantBubble.classList.add('joule-msg--error');
      return;
    }

    if (res.status === 401) { window.location.href = '/login?returnTo=' + encodeURIComponent(location.pathname); return; }
    if (res.status === 503) { assistantBubble.textContent = 'Joule is currently unavailable.'; assistantBubble.classList.add('joule-msg--error'); return; }
    if (res.status === 429) { assistantBubble.textContent = "You've reached today's chat limit."; assistantBubble.classList.add('joule-msg--error'); return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const evt of events) {
        const line = evt.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim());
          if (payload.type === 'delta') {
            assistantText += payload.content;
            assistantBubble.textContent = assistantText;
          } else if (payload.type === 'tool') {
            const chip = document.createElement('div');
            chip.className = 'joule-tool-chip';
            chip.textContent = `Searching for ${payload.args?.query || '…'}`;
            transcript.insertBefore(chip, assistantBubble);
          } else if (payload.type === 'done') {
            messages.push({ role: 'assistant', content: assistantText });
            saveHistory(messages);
          } else if (payload.type === 'error') {
            assistantBubble.textContent = payload.reason === 'content_filter'
              ? "I can't help with that. Try asking about SAP tutorials."
              : 'Something went wrong. Please try again.';
            assistantBubble.classList.add('joule-msg--error');
          }
        } catch { /* drop malformed event */ }
      }
    }
  }

  function open() {
    panel.hidden = false;
    const messages = loadHistory();
    if (messages.length) renderTranscript(messages);
    else renderGreeting(readUser()?.firstName);
    input.focus();
  }
  function close() { panel.hidden = true; }

  trigger.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    send(msg);
  });

  loadConfig().then(cfg => {
    if (!cfg.enabled) { trigger.remove(); return; }
    trigger.hidden = false;
    if (cfg.bannerText) { banner.textContent = cfg.bannerText; banner.hidden = false; }
  });
})();
```

- [ ] **Step 6: Run Hugo dev server and smoke-check**

Run: `npm run dev` and load `http://localhost:1313`
Expected: with the flag still off (default), the Joule trigger remains hidden. Manually flip the row in HANA via the admin UI (Task 9) before chat will activate.

- [ ] **Step 7: Commit**

```bash
git add hugo/layouts/_default/baseof.html hugo/layouts/partials/header.html hugo/layouts/partials/joule-panel.html hugo/static/js/joule.js hugo/static/css/joule.css
git commit -m "feat(chat): Joule panel UI with SSE client and page-context wiring"
```

---

## Task 9: Admin UI — Joule Settings ObjectPage + admin-shell registration

**Files:**
- Create: `app/admin/joule-settings/webapp/manifest.json`
- Create: `app/admin/joule-settings/webapp/Component.js`
- Create: `app/admin/joule-settings/webapp/index.html`
- Create: `app/admin/joule-settings/webapp/i18n/i18n.properties`
- Create: `app/admin/joule-settings/package.json`
- Create: `app/admin/joule-settings/ui5.yaml`
- Modify: `app/admin-shell/webapp/manifest.json`
- Modify: `app/admin-shell/webapp/model/navigation.json`
- Modify: `app/admin-shell/package.json`

- [ ] **Step 1: Create the joule-settings UI5 app**

Use the existing `app/admin/operations/` as the structural template — same `_version`, `sap.app.dataSources.adminService` URI `/admin/`, `sap.fe.templates` libs.

`app/admin/joule-settings/webapp/manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.joule",
    "type": "application",
    "title": "Joule Chat Settings",
    "dataSources": {
      "adminService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.m": {}, "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "adminService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": { "type": "sap.ui.model.resource.ResourceModel", "settings": { "bundleName": "sap.tutorials.admin.joule.i18n.i18n" } }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "JouleSettings", "target": "JouleSettings" }
      ],
      "targets": {
        "JouleSettings": {
          "type": "Component",
          "id": "JouleSettings",
          "name": "sap.fe.templates.ObjectPage",
          "options": {
            "settings": {
              "contextPath": "/ChatSettings",
              "editableHeaderContent": false
            }
          }
        }
      }
    }
  }
}
```

`app/admin/joule-settings/webapp/Component.js`:

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.joule.Component", { metadata: { manifest: "json" } });
});
```

`app/admin/joule-settings/webapp/index.html`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Joule Settings</title>
<script id="sap-ui-bootstrap" src="resources/sap-ui-core.js"
        data-sap-ui-theme="sap_horizon"
        data-sap-ui-resource-roots='{"sap.tutorials.admin.joule":"./"}'
        data-sap-ui-async="true"
        data-sap-ui-on-init="module:sap/ui/core/ComponentSupport"></script>
</head><body class="sapUiBody" id="content">
  <div data-sap-ui-component data-name="sap.tutorials.admin.joule" data-id="container" data-settings='{"id":"joule"}'></div>
</body></html>
```

`app/admin/joule-settings/webapp/i18n/i18n.properties`:

```
appTitle=Joule Chat Settings
```

`app/admin/joule-settings/package.json` and `ui5.yaml`: copy from `app/admin/operations/` and rename the namespace `sap.tutorials.admin.operations` → `sap.tutorials.admin.joule`. Build script must produce `dist/`.

- [ ] **Step 2: Register the component in `app/admin-shell/webapp/manifest.json`**

Inside `sap.ui5.resourceRoots`, add:

```json
"sap.tutorials.admin.joule": "./components/joule"
```

Inside `sap.ui5.componentUsages`:

```json
"jouleSettingsComponent": {
  "name": "sap.tutorials.admin.joule",
  "settings": {},
  "componentData": {},
  "lazy": true
}
```

Inside `routing.routes`:

```json
{ "name": "joule", "pattern": "joule", "target": [{"name": "jouleSettingsTarget", "prefix": "jo"}] }
```

Inside `routing.targets`:

```json
"jouleSettingsTarget": {
  "type": "Component",
  "usage": "jouleSettingsComponent",
  "id": "jouleSettingsTarget",
  "viewLevel": 1,
  "prefix": "jo"
}
```

- [ ] **Step 3: Add the navigation entry in `app/admin-shell/webapp/model/navigation.json`**

Inside the `system` group's `items` array, add (positioned between Operations and Privacy per the spec):

```json
{ "key": "joule", "title": "Joule Chat", "icon": "sap-icon://da" }
```

The shell's router maps a nav entry's `key` directly to the route `name` declared in `manifest.json` — confirmed by inspecting `app/admin-shell/webapp/model/navigation.json` (other entries have only `key/title/icon`). Adding a `route` field would be a no-op or pattern mismatch.

- [ ] **Step 4: Wire the build copy in `app/admin-shell/package.json`**

Add a build step that copies `app/admin/joule-settings/dist/` to `app/admin-shell/dist/components/joule/` — mirror whatever existing build copies the other 10 components (e.g., a `cpr` or `shx cp -r` line in the `build` script).

- [ ] **Step 5: Build and verify**

Run: `npm run build:admin`
Expected: no errors. Inspect `app/admin-shell/dist/components/joule/manifest.json` to confirm the joule app was copied.

- [ ] **Step 6: Local hybrid smoke**

Run: `npm run dev:hybrid` then open `http://localhost:5000/admin-ui/#/joule`
Expected: ObjectPage renders the four fields; toggling `enabled` and saving updates the singleton row. Verify by `curl http://localhost:5000/api/ChatConfig` reflects the change.

- [ ] **Step 7: Commit**

```bash
git add app/admin/joule-settings app/admin-shell/webapp/manifest.json app/admin-shell/webapp/model/navigation.json app/admin-shell/package.json
git commit -m "feat(chat): Joule Settings admin app + admin-shell navigation entry"
```

---

## Task 10: MTA aicore binding + hybrid + smoke tests

**Files:**
- Modify: `.deploy/mta.yaml`
- Create: `test/hybrid/chat-settings.test.js`
- Create: `test/smoke/chat.test.js`

- [ ] **Step 1: Add the aicore service to `.deploy/mta.yaml`**

In the `resources:` section:

```yaml
- name: tutorial-system-aicore
  type: org.cloudfoundry.managed-service
  parameters:
    service: aicore
    service-plan: extended
```

Inside the `tutorials-srv` module's `requires:` list:

```yaml
- name: tutorial-system-aicore
```

- [ ] **Step 2: Write the hybrid test `test/hybrid/chat-settings.test.js` (ESM, vitest)**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('ChatSettings (hybrid)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('singleton row is present after deploy', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(ChatSettings));
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(false);
  });

  it('public ChatConfig only exposes enabled and bannerText', async () => {
    // cds.test mounts the server on a random port — use the test fixture's URL
    const url = `${cds.test.url}/api/ChatConfig`;
    const r = await fetch(url);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('enabled');
    expect(j).toHaveProperty('bannerText');
    expect(j).not.toHaveProperty('deploymentId');
    expect(j).not.toHaveProperty('maxRequestsPerUser');
  });
});
```

- [ ] **Step 3: Write the smoke test `test/smoke/chat.test.js` (ESM, vitest)**

```js
import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule chat smoke', () => {
  it('GET /api/ChatConfig responds with JSON', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/api/ChatConfig`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/json/);
    const j = await r.json();
    expect(typeof j.enabled).toBe('boolean');
    // Defense in depth: never leak server-only fields
    expect(j).not.toHaveProperty('deploymentId');
    expect(j).not.toHaveProperty('maxRequestsPerUser');
  });

  it('POST /chat/stream returns 401 for anonymous', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], pageContext: { kind: 'generic' } })
    });
    expect(r.status).toBe(401);
  });

  // Note: smoke runs against a deployed env. Without an authenticated request we
  // only validate the unauth gate (401). The 503 (kill-switch) and 200 (happy)
  // paths are exercised by the hybrid suite (locally bound) and the manual
  // post-deploy verification checklist below.
});
```

- [ ] **Step 4: Run the hybrid suite**

Pre-req: `cf login` to the dev space and `cds bind --to db,aicore` so the hybrid profile picks up real bindings.

Run: `npm run test:hybrid -- chat-settings`
Expected: PASS — singleton row present with `enabled=false`; `/api/ChatConfig` exposes only `enabled` and `bannerText`.

- [ ] **Step 5: Run the smoke suite against the deployed URL**

Run: `SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com npm run test:smoke -- chat`
Expected: PASS — `/api/ChatConfig` returns JSON without server-only fields, `/chat/stream` returns 401 unauthenticated.

- [ ] **Step 6: Commit**

```bash
git add .deploy/mta.yaml test/hybrid/chat-settings.test.js test/smoke/chat.test.js
git commit -m "feat(chat): aicore service binding + hybrid/smoke tests"
```

---

## Post-implementation manual verification

Once Tasks 1–10 are merged and deployed:

1. In SAP AI Core Generative AI Hub, provision an orchestration deployment (e.g. `gpt-4o-mini`) and copy the deployment ID.
2. Open `/admin-ui/#/joule`, paste the deployment ID into **AI Core Deployment ID**, set **Max Requests / User / Day** (default 100), optionally fill **Banner Text** (e.g. "Joule is in beta"), then toggle **Enabled** ON and save.
3. Within ~60 s the Joule icon appears for logged-in users in the Hugo header.
4. Verify on a tutorial page that asking "summarize this tutorial" returns content grounded in the page; on the home/search page that asking "find me a CAP tutorial" surfaces matching results with slugs.
5. To kill the feature: toggle **Enabled** OFF — the icon disappears within ~60 s and `/chat/stream` returns 503 immediately.
