# k6 Load-Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a k6-driven load-test suite under `test/load/` with five scenarios (smoke, public-baseline, public-ramp, tutorial-serve, websocket-handshake), package-json passthrough scripts, a weekly-cron GitHub workflow with threshold-based CI gating, and a developer runbook — inert until run, DEV-only for v1, tied to #805 observability via the runbook.

**Architecture:** k6 (Go binary) drives HTTP + Socket.IO against the deployed DEV AppRouter / srv. Each scenario is a standalone `.js` file that imports `test/load/config.js` (thresholds, URLs, tags) and helpers from `test/load/lib/`. CI runs the pinned `grafana/k6:0.51.0` Docker image via `docker run`; thresholds baked into scenarios drive the non-zero exit that fails the workflow. The workflow starts with a "publish-in-flight" probe that aborts cleanly if a rebuild is running against DEV mid-run.

**Tech Stack:** k6 0.51.0, Node 20+ (runbook only — no Node runtime code), GitHub Actions, Docker image `grafana/k6:0.51.0`, ES modules (k6 JS format).

## Global Constraints

- **Spec:** [docs/superpowers/specs/2026-07-03-804-load-test-suite-design.md](../specs/2026-07-03-804-load-test-suite-design.md). Deviations require a spec bump.
- **k6 image pinned:** `grafana/k6:0.51.0`. Upgrade = separate PR + manual smoke.
- **DEV-only.** No PROD URLs, no PROD tokens. `LOAD_BASE_URL` default: `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com`.
- **Public endpoints only.** No `Authorization` headers, no XSUAA token flow.
- **No PR trigger** on `load-test.yml`. `schedule` (Mon 03:00 UTC) + `workflow_dispatch` only.
- **File paths use forward slashes** in all committed content (Node/k6/GH Actions cross-platform). Windows path separators in-repo are a bug.
- **Env-var naming:** all scenario knobs are `LOAD_*` (`LOAD_BASE_URL`, `LOAD_SRV_URL`, `LOAD_VUS`, `LOAD_DURATION`, `LOAD_MODE`, `LOAD_SUMMARY_PATH`).
- **Line endings:** LF. Windows contributors: worktree already has `.gitattributes`; do not rewrite.
- **Threshold source of truth:** `test/load/config.js` `THRESHOLDS` table. Never hardcode ms values in scenario files — always import from config.

---

## File structure

Files created:

- `test/load/README.md` — install + quick-start.
- `test/load/config.js` — URL resolution, thresholds table, tag conventions, env parsing.
- `test/load/lib/checks.js` — shared `check(res, name)` wrappers (status + content-type).
- `test/load/lib/http.js` — tagged HTTP GET wrapper that stamps `endpoint` and `scenario` tags for threshold routing.
- `test/load/lib/slugs.js` — one-shot fetch of `/build/catalog` in `setup()`, returns slug array shared across VUs.
- `test/load/scenarios/01-smoke.js` — 1 VU × 30 s, one hit per endpoint class.
- `test/load/scenarios/02-public-baseline.js` — 10 VU × 2 min, weighted mix.
- `test/load/scenarios/03-public-ramp.js` — 0 → 100 VU ramp, weighted mix.
- `test/load/scenarios/04-tutorial-serve.js` — 50 VU × 3 min, `--env MODE=hot|cold`.
- `test/load/scenarios/05-websocket-handshake.js` — 20 VU × 30 s, Socket.IO connect/disconnect.
- `docs/developers/operations/load-testing.md` — runbook.
- `.github/workflows/load-test.yml` — weekly cron + dispatch, publish-in-flight guard, threshold gating.

Files modified:

- `package.json` — add 5 `loadtest:*` scripts.
- `CLAUDE.md` — one gotcha bullet in the Gotchas section.
- `docs/.vitepress/config.ts` — register the new runbook in the sidebar (`predocs:build` guard rejects unregistered pages).

Nothing else touches product code.

---

## Task 1: Shared config + helpers

**Files:**
- Create: `test/load/config.js`
- Create: `test/load/lib/checks.js`
- Create: `test/load/lib/http.js`
- Create: `test/load/lib/slugs.js`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `config.js` exports: `BASE_URL` (string), `SRV_URL` (string), `SUMMARY_PATH` (string), `MODE` (string), `envInt(name, fallback)` (function), `THRESHOLDS` (object — see below), `tagsFor(endpoint)` (function returning `{ endpoint }`).
  - `lib/checks.js` exports: `checkJson(res, endpointLabel)` (returns boolean), `checkHtml(res, endpointLabel)` (returns boolean), `checkImage(res, endpointLabel, expectedMime)` (returns boolean).
  - `lib/http.js` exports: `getTagged(url, endpointLabel, extraParams)` — wraps `http.get` with `tags: { endpoint: endpointLabel }` merged into `extraParams`.
  - `lib/slugs.js` exports: default function `fetchSlugs(srvUrl)` — GETs `/build/catalog`, returns `{ tutorialSlugs: string[], advocateSlugs: string[] }`.

- [ ] **Step 1: Create `test/load/config.js`**

```javascript
// test/load/config.js
// Central config for all k6 scenarios. Threshold values live here only —
// never hardcode ms values in scenario files.

const DEFAULT_BASE_URL =
  'https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com';

// __ENV is k6's env-var namespace. Empty string counts as unset.
function envOr(name, fallback) {
  const v = __ENV[name];
  return v && v.length > 0 ? v : fallback;
}

function envInt(name, fallback) {
  const v = __ENV[name];
  if (!v || v.length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const BASE_URL = envOr('LOAD_BASE_URL', DEFAULT_BASE_URL);
// If LOAD_SRV_URL not set, derive from BASE_URL by inserting `-tutorials-srv`
// in place of `-tutorials-approuter`. AppRouter and srv are separate CF apps
// in DEV; /build/* is served by srv.
const SRV_URL = envOr(
  'LOAD_SRV_URL',
  BASE_URL.replace('-tutorials-approuter', '-tutorials-srv'),
);
const SUMMARY_PATH = envOr('LOAD_SUMMARY_PATH', 'k6-summary.json');
const MODE = envOr('LOAD_MODE', 'cold');

// Threshold table. Keys map to `endpoint` tag values stamped on requests
// by lib/http.js. k6 evaluates these at the end of the run and exits
// non-zero if any is violated.
const THRESHOLDS = {
  // Global smoke ceiling.
  'http_req_failed{scenario:smoke}': ['rate<0.01'],

  // Baseline scenario (Task 4).
  'http_req_duration{endpoint:build-catalog}': ['p(95)<500'],
  'http_req_duration{endpoint:build-navigator}': ['p(95)<500'],
  'http_req_duration{endpoint:tutorial}': ['p(95)<300'],
  'http_req_duration{endpoint:advocates-list}': ['p(95)<200'],
  'http_req_duration{endpoint:advocates-photo}': ['p(95)<300'],
  'http_req_failed{endpoint:build-catalog}': ['rate<0.01'],
  'http_req_failed{endpoint:build-navigator}': ['rate<0.01'],
  'http_req_failed{endpoint:tutorial}': ['rate<0.01'],
  'http_req_failed{endpoint:advocates-list}': ['rate<0.005'],
  'http_req_failed{endpoint:advocates-photo}': ['rate<0.005'],

  // Ramp scenario is 2× baseline (softer; see spec section 3).
  'http_req_duration{scenario:ramp,endpoint:tutorial}': ['p(95)<600'],
  'http_req_duration{scenario:ramp,endpoint:build-catalog}': ['p(95)<1000'],

  // Tutorial-serve scenario (cache modes).
  'http_req_duration{scenario:tutorial-serve,mode:hot}': ['p(95)<150'],
  'http_req_duration{scenario:tutorial-serve,mode:cold}': ['p(95)<500'],

  // WebSocket handshake.
  'ws_connecting{scenario:ws}': ['p(95)<1000'],
  'ws_session_errors{scenario:ws}': ['rate<0.02'],
};

function tagsFor(endpoint) {
  return { endpoint };
}

export {
  BASE_URL,
  SRV_URL,
  SUMMARY_PATH,
  MODE,
  THRESHOLDS,
  envInt,
  tagsFor,
};
```

- [ ] **Step 2: Create `test/load/lib/checks.js`**

```javascript
// test/load/lib/checks.js
// Shared response validators. Each takes the response and a label used
// only for the k6 check-name (so it shows up per-endpoint in the summary).

import { check } from 'k6';

export function checkJson(res, endpointLabel) {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type json`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes('application/json'),
  });
}

export function checkHtml(res, endpointLabel) {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type html`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes('text/html'),
  });
}

export function checkImage(res, endpointLabel, expectedMime = 'image/webp') {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type ${expectedMime}`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes(expectedMime),
  });
}
```

- [ ] **Step 3: Create `test/load/lib/http.js`**

```javascript
// test/load/lib/http.js
// Tagged HTTP GET. Every request in every scenario should go through this
// so that thresholds keyed on {endpoint:...} in config.js actually match.

import http from 'k6/http';
import { tagsFor } from '../config.js';

export function getTagged(url, endpointLabel, extraParams = {}) {
  const params = {
    ...extraParams,
    tags: { ...tagsFor(endpointLabel), ...(extraParams.tags || {}) },
  };
  return http.get(url, params);
}
```

- [ ] **Step 4: Create `test/load/lib/slugs.js`**

```javascript
// test/load/lib/slugs.js
// One-shot slug fetch used in each scenario's setup() function. k6 runs
// setup() ONCE before VUs start; its return value is passed to the
// default export and shared across VUs (immutable in workers).

import http from 'k6/http';

export default function fetchSlugs(srvUrl) {
  const res = http.get(`${srvUrl}/build/catalog`, {
    tags: { endpoint: 'setup-catalog' },
    timeout: '30s',
  });
  if (res.status !== 200) {
    throw new Error(
      `setup: /build/catalog returned ${res.status} — cannot resolve slugs`,
    );
  }
  const body = res.json();
  const tutorialSlugs = [];
  // Catalog shape: { missions: [ { tutorials: [ { slug } ] } ] }
  // Defensive: unknown extras are OK, missing arrays are fatal.
  for (const mission of body.missions || []) {
    for (const t of mission.tutorials || []) {
      if (t && typeof t.slug === 'string' && t.slug.length > 0) {
        tutorialSlugs.push(t.slug);
      }
    }
  }
  if (tutorialSlugs.length === 0) {
    throw new Error(
      'setup: /build/catalog returned zero tutorial slugs — env misconfigured?',
    );
  }

  // Advocates list — separate endpoint, one lookup.
  const advRes = http.get(`${srvUrl}/api/advocates`, {
    tags: { endpoint: 'setup-advocates' },
    timeout: '30s',
  });
  const advocateSlugs = [];
  if (advRes.status === 200) {
    const advBody = advRes.json();
    for (const a of advBody.advocates || advBody || []) {
      if (a && typeof a.slug === 'string' && a.slug.length > 0) {
        advocateSlugs.push(a.slug);
      }
    }
  }
  // Advocates being empty is a warning, not fatal — the /api/advocates/:slug/photo
  // scenario step will simply skip if no slugs are available.
  return { tutorialSlugs, advocateSlugs };
}
```

- [ ] **Step 5: Static syntax check with Node**

k6 scenarios are ES-module JS. We can't `import k6/http` under Node, but we CAN check that config.js and the helper files parse. Run:

```bash
node --check test/load/config.js
node --check test/load/lib/checks.js
node --check test/load/lib/http.js
node --check test/load/lib/slugs.js
```

Expected: no output (success). Any syntax error = FAIL.

- [ ] **Step 6: Commit**

```bash
git add test/load/config.js test/load/lib/
git commit -m "feat(#804): k6 load-test shared config + helpers"
```

---

## Task 2: Smoke scenario

**Files:**
- Create: `test/load/scenarios/01-smoke.js`

**Interfaces:**
- Consumes: `config.js`, `lib/http.js`, `lib/checks.js`, `lib/slugs.js` from Task 1.
- Produces: nothing (leaf scenario).

- [ ] **Step 1: Create `test/load/scenarios/01-smoke.js`**

```javascript
// test/load/scenarios/01-smoke.js
// 1 VU × 30 s. One hit per endpoint class. Verifies the harness is wired
// (env vars resolve, setup() fetches slugs, WebSocket handshake completes).

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkJson, checkHtml, checkImage } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { scenario: 'smoke' },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  return fetchSlugs(SRV_URL);
}

export default function (data) {
  const slug = data.tutorialSlugs[0];

  checkJson(getTagged(`${SRV_URL}/build/catalog`, 'build-catalog'), 'build-catalog');
  checkJson(getTagged(`${SRV_URL}/build/navigator`, 'build-navigator'), 'build-navigator');
  checkHtml(getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial'), 'tutorial');
  checkJson(getTagged(`${SRV_URL}/api/advocates`, 'advocates-list'), 'advocates-list');
  if (data.advocateSlugs.length > 0) {
    checkImage(
      getTagged(
        `${SRV_URL}/api/advocates/${data.advocateSlugs[0]}/photo`,
        'advocates-photo',
      ),
      'advocates-photo',
      'image/',
    );
  }

  sleep(1);
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2), stdout: textSummary(data) };
}

// Minimal stdout summary — k6 no longer ships handleSummary defaults in 0.51.
function textSummary(data) {
  const m = data.metrics;
  const p95 = (name) =>
    m[name] && m[name].values && m[name].values['p(95)']
      ? `${m[name].values['p(95)'].toFixed(1)}ms`
      : 'n/a';
  return `smoke: http_req_duration p95=${p95('http_req_duration')} errors=${m.http_req_failed?.values?.rate?.toFixed(4) ?? 'n/a'}\n`;
}
```

- [ ] **Step 2: Parse-check**

```bash
node --check test/load/scenarios/01-smoke.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/load/scenarios/01-smoke.js
git commit -m "feat(#804): k6 smoke scenario (1 VU × 30s)"
```

---

## Task 3: Baseline scenario

**Files:**
- Create: `test/load/scenarios/02-public-baseline.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: nothing.

- [ ] **Step 1: Create `test/load/scenarios/02-public-baseline.js`**

```javascript
// test/load/scenarios/02-public-baseline.js
// 10 VU × 2 min. Weighted endpoint mix — see spec section 2.
// Weights: catalog 20 / navigator 10 / tutorial 50 / advocates-list 15 / advocates-photo 5.

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkJson, checkHtml, checkImage } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      tags: { scenario: 'baseline' },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  return fetchSlugs(SRV_URL);
}

// Weighted picker: cumulative-probability table. `roll` is [0, 100).
const MIX = [
  { max: 20, endpoint: 'build-catalog' },
  { max: 30, endpoint: 'build-navigator' },
  { max: 80, endpoint: 'tutorial' },
  { max: 95, endpoint: 'advocates-list' },
  { max: 100, endpoint: 'advocates-photo' },
];

function pickEndpoint() {
  const roll = Math.random() * 100;
  for (const m of MIX) {
    if (roll < m.max) return m.endpoint;
  }
  return MIX[MIX.length - 1].endpoint;
}

export default function (data) {
  const which = pickEndpoint();
  switch (which) {
    case 'build-catalog':
      checkJson(getTagged(`${SRV_URL}/build/catalog`, 'build-catalog'), 'build-catalog');
      break;
    case 'build-navigator':
      checkJson(getTagged(`${SRV_URL}/build/navigator`, 'build-navigator'), 'build-navigator');
      break;
    case 'tutorial': {
      const slug = data.tutorialSlugs[Math.floor(Math.random() * data.tutorialSlugs.length)];
      checkHtml(getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial'), 'tutorial');
      break;
    }
    case 'advocates-list':
      checkJson(getTagged(`${SRV_URL}/api/advocates`, 'advocates-list'), 'advocates-list');
      break;
    case 'advocates-photo': {
      if (data.advocateSlugs.length === 0) break;
      const slug = data.advocateSlugs[Math.floor(Math.random() * data.advocateSlugs.length)];
      checkImage(
        getTagged(`${SRV_URL}/api/advocates/${slug}/photo`, 'advocates-photo'),
        'advocates-photo',
        'image/',
      );
      break;
    }
  }
  sleep(0.3 + Math.random() * 0.4); // 300–700 ms think time
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
```

- [ ] **Step 2: Parse-check**

```bash
node --check test/load/scenarios/02-public-baseline.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/load/scenarios/02-public-baseline.js
git commit -m "feat(#804): k6 public-baseline scenario (10 VU × 2m, weighted mix)"
```

---

## Task 4: Ramp scenario

**Files:**
- Create: `test/load/scenarios/03-public-ramp.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: nothing.

- [ ] **Step 1: Create `test/load/scenarios/03-public-ramp.js`**

```javascript
// test/load/scenarios/03-public-ramp.js
// Ramp 0 → 100 VU over 5 min, hold 10 min. Same endpoint mix as baseline.
// Threshold is 2× baseline (softer — see spec section 3).

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkJson, checkHtml, checkImage } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 100 },
        { duration: '10m', target: 100 },
      ],
      tags: { scenario: 'ramp' },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  return fetchSlugs(SRV_URL);
}

const MIX = [
  { max: 20, endpoint: 'build-catalog' },
  { max: 30, endpoint: 'build-navigator' },
  { max: 80, endpoint: 'tutorial' },
  { max: 95, endpoint: 'advocates-list' },
  { max: 100, endpoint: 'advocates-photo' },
];

function pickEndpoint() {
  const roll = Math.random() * 100;
  for (const m of MIX) {
    if (roll < m.max) return m.endpoint;
  }
  return MIX[MIX.length - 1].endpoint;
}

export default function (data) {
  const which = pickEndpoint();
  switch (which) {
    case 'build-catalog':
      checkJson(getTagged(`${SRV_URL}/build/catalog`, 'build-catalog'), 'build-catalog');
      break;
    case 'build-navigator':
      checkJson(getTagged(`${SRV_URL}/build/navigator`, 'build-navigator'), 'build-navigator');
      break;
    case 'tutorial': {
      const slug = data.tutorialSlugs[Math.floor(Math.random() * data.tutorialSlugs.length)];
      checkHtml(getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial'), 'tutorial');
      break;
    }
    case 'advocates-list':
      checkJson(getTagged(`${SRV_URL}/api/advocates`, 'advocates-list'), 'advocates-list');
      break;
    case 'advocates-photo': {
      if (data.advocateSlugs.length === 0) break;
      const slug = data.advocateSlugs[Math.floor(Math.random() * data.advocateSlugs.length)];
      checkImage(
        getTagged(`${SRV_URL}/api/advocates/${slug}/photo`, 'advocates-photo'),
        'advocates-photo',
        'image/',
      );
      break;
    }
  }
  sleep(0.3 + Math.random() * 0.4);
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
```

- [ ] **Step 2: Parse-check**

```bash
node --check test/load/scenarios/03-public-ramp.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/load/scenarios/03-public-ramp.js
git commit -m "feat(#804): k6 public-ramp scenario (0→100 VU, 15 min total)"
```

---

## Task 5: Tutorial-serve scenario (cache modes)

**Files:**
- Create: `test/load/scenarios/04-tutorial-serve.js`

**Interfaces:**
- Consumes: Task 1 exports, `MODE` env var.
- Produces: nothing.

- [ ] **Step 1: Create `test/load/scenarios/04-tutorial-serve.js`**

```javascript
// test/load/scenarios/04-tutorial-serve.js
// 50 VU × 3 min hammering /tutorials/{slug}. LOAD_MODE=hot|cold (default cold).
// Isolates the HANA BLOB decompress + LRU cache path.

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, MODE, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkHtml } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    tutorialServe: {
      executor: 'constant-vus',
      vus: 50,
      duration: '3m',
      tags: { scenario: 'tutorial-serve', mode: MODE },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  const slugs = fetchSlugs(SRV_URL);
  // Hot mode: pick 10 fixed slugs at setup, share across all VUs.
  const hotSlugs =
    MODE === 'hot'
      ? slugs.tutorialSlugs.slice(0, Math.min(10, slugs.tutorialSlugs.length))
      : null;
  return { ...slugs, hotSlugs };
}

export default function (data) {
  let slug;
  if (MODE === 'hot') {
    slug = data.hotSlugs[Math.floor(Math.random() * data.hotSlugs.length)];
  } else {
    slug = data.tutorialSlugs[Math.floor(Math.random() * data.tutorialSlugs.length)];
  }
  checkHtml(
    getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial', {
      tags: { mode: MODE },
    }),
    'tutorial',
  );
  sleep(0.1 + Math.random() * 0.2);
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
```

- [ ] **Step 2: Parse-check**

```bash
node --check test/load/scenarios/04-tutorial-serve.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/load/scenarios/04-tutorial-serve.js
git commit -m "feat(#804): k6 tutorial-serve scenario (50 VU × 3m, hot/cold modes)"
```

---

## Task 6: WebSocket handshake scenario

**Files:**
- Create: `test/load/scenarios/05-websocket-handshake.js`

**Interfaces:**
- Consumes: `BASE_URL`, `SUMMARY_PATH`, `THRESHOLDS`.
- Produces: nothing.

- [ ] **Step 1: Create `test/load/scenarios/05-websocket-handshake.js`**

```javascript
// test/load/scenarios/05-websocket-handshake.js
// 20 VU each opening a Socket.IO connection on /ws/event-stream, waiting
// for the connect ack, disconnecting. No message traffic — connection churn only.
//
// Note: Socket.IO's initial HTTP polling handshake is what we measure. k6's
// ws module handles the WebSocket upgrade; we time from ws.connect() start
// to the first message received from the server.

import ws from 'k6/ws';
import { check, fail } from 'k6';
import { BASE_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';

export const options = {
  scenarios: {
    wsHandshake: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 30,          // ~30s of churn per VU at ~1s per iteration
      maxDuration: '2m',
      tags: { scenario: 'ws' },
    },
  },
  thresholds: THRESHOLDS,
};

export default function () {
  // Socket.IO handshake URL. approuter passes /socket.io/ through unauth.
  const url = `${BASE_URL.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket&namespace=/ws/event-stream`;
  const res = ws.connect(url, { tags: { endpoint: 'ws-handshake' } }, (socket) => {
    socket.on('open', () => {
      // Socket.IO v4 protocol: server sends '0{...}' handshake, then client
      // sends '40/ws/event-stream' to join namespace. We only care about
      // the initial handshake round-trip for throughput.
      socket.setTimeout(() => socket.close(), 500);
    });
    socket.on('error', (e) => {
      // Count as ws_session_errors — k6 auto-tracks.
      if (e && e.error && !String(e.error).match(/closed/i)) {
        console.warn(`ws error: ${e.error}`);
      }
    });
  });
  check(res, { 'ws handshake status 101': (r) => r && r.status === 101 });
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
```

- [ ] **Step 2: Parse-check**

```bash
node --check test/load/scenarios/05-websocket-handshake.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add test/load/scenarios/05-websocket-handshake.js
git commit -m "feat(#804): k6 websocket-handshake scenario (20 VU × 30s)"
```

---

## Task 7: Package-json scripts

**Files:**
- Modify: `package.json` — insert 5 `loadtest:*` keys under `"scripts"`.

**Interfaces:**
- Consumes: Task 2–6 scenario files.
- Produces: `npm run loadtest:*` commands.

- [ ] **Step 1: Add the scripts**

Find the `"scripts"` block in `package.json`. Insert these five keys in alphabetical order relative to existing keys (they cluster near `test:*`):

```json
"loadtest:baseline": "k6 run test/load/scenarios/02-public-baseline.js",
"loadtest:ramp": "k6 run test/load/scenarios/03-public-ramp.js",
"loadtest:smoke": "k6 run test/load/scenarios/01-smoke.js",
"loadtest:tutorials": "k6 run test/load/scenarios/04-tutorial-serve.js",
"loadtest:ws": "k6 run test/load/scenarios/05-websocket-handshake.js",
```

Use `Edit` to add each line — do NOT rewrite the whole `"scripts"` block. Match the existing indentation (4 spaces in this repo's `package.json`).

- [ ] **Step 2: Validate**

```bash
jq '.scripts | keys[] | select(startswith("loadtest:"))' package.json
```

Expected output (5 lines):

```
"loadtest:baseline"
"loadtest:ramp"
"loadtest:smoke"
"loadtest:tutorials"
"loadtest:ws"
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(#804): loadtest:* npm scripts (passthrough to k6 run)"
```

---

## Task 8: Runbook

**Files:**
- Create: `docs/developers/operations/load-testing.md`

**Interfaces:**
- Consumes: everything so far (referenced by name).
- Produces: user-facing runbook.

- [ ] **Step 1: Create the runbook**

```markdown
# Load Testing (k6)

> **Status:** DEV-only for v1. See spec [#804](https://github.com/sap-tutorials/tutorials-ims/issues/804) / [docs/superpowers/specs/2026-07-03-804-load-test-suite-design.md](../../superpowers/specs/2026-07-03-804-load-test-suite-design.md).

Load tests live under `test/load/` and run via [k6](https://k6.io). They are read-only against public endpoints on the deployed DEV app. There is **no PR trigger** — CI runs them weekly (Monday 03:00 UTC) and on manual `workflow_dispatch`.

## Install k6

| OS | Command |
|---|---|
| Windows | `winget install k6.k6` |
| macOS | `brew install k6` |
| Linux | see [k6 docs](https://grafana.com/docs/k6/latest/set-up/install-k6/) |
| Any | `docker run --rm -i grafana/k6:0.51.0 run - < test/load/scenarios/01-smoke.js` |

Version pinned to **0.51.0** in CI. Local versions ≥ 0.51 are fine.

## Run a scenario locally

```bash
# Sanity check (30 s, 1 VU)
npm run loadtest:smoke

# 2-min steady baseline
npm run loadtest:baseline

# 15-min ramp — only run when investigating a regression
npm run loadtest:ramp

# Isolate the tutorial-serve HANA/LRU path
LOAD_MODE=cold npm run loadtest:tutorials
LOAD_MODE=hot  npm run loadtest:tutorials

# Socket.IO handshake churn
npm run loadtest:ws
```

Point at a different environment by setting `LOAD_BASE_URL` (AppRouter URL). `LOAD_SRV_URL` is auto-derived from `LOAD_BASE_URL` by replacing `-tutorials-approuter` with `-tutorials-srv`; override it if your naming differs.

```bash
LOAD_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
  npm run loadtest:smoke
```

## Interpret the summary

Every scenario writes `k6-summary.json` at the end of the run (path overridable via `LOAD_SUMMARY_PATH`). Key fields:

- `metrics.http_req_duration.values["p(95)"]` — overall 95th-percentile latency.
- `metrics["http_req_duration{endpoint:tutorial}"].values["p(95)"]` — per-endpoint p95.
- `metrics.http_req_failed.values.rate` — global error rate (0–1).
- `root_group.checks[]` — pass/fail counts per named check.
- Threshold violations surface in `metrics[...].thresholds` and exit non-zero from k6.

Threshold values are centralised in [`test/load/config.js`](../../../test/load/config.js) — `THRESHOLDS`. Never hardcode ms values in scenario files.

## Threshold philosophy

Provisional ceilings, roughly 3× measured baseline. If runs consistently sit far below the ceiling, tighten it. If runs bump the ceiling, **investigate before relaxing.** A cache-eviction storm at high VU is a real observation, not an excuse to widen the threshold.

## Publish-in-flight guard

The CI workflow hits `GET /content/hashes` twice with 10 s between; if the manifest version changes, it aborts with `SKIP: publish in progress` and does **not** upload an artifact. This prevents a scheduled load run from polluting numbers during a `rebuild-content.yml` publish. Locally, if you know a publish is running, wait.

## Pair with #805 observability

Load runs are most useful when read against the metrics rollups from [#805](../../superpowers/specs/2026-07-02-805-observability-instrumentation-design.md):

```bash
# Before
curl -su "$ADMIN_BASIC_AUTH" $SRV_URL/admin/metrics/live > before.json

# Run
npm run loadtest:tutorials

# After
curl -su "$ADMIN_BASIC_AUTH" $SRV_URL/admin/metrics/live > after.json

# Diff cache stats, HANA acquire latency, publish timings
diff <(jq -S . before.json) <(jq -S . after.json)
```

For weekly CI runs, open `/admin-ui/#metrics` and look at the 03:00–03:30 UTC Monday window in the `MetricSnapshots` chart.

## Adding a new scenario

1. Add a scenario file at `test/load/scenarios/NN-<name>.js`. Copy the smallest existing scenario as a template.
2. Add thresholds to `test/load/config.js` `THRESHOLDS`. Key them on `{scenario:<name>,endpoint:...}` so they don't accidentally match other scenarios.
3. Add a `loadtest:<name>` script to `package.json`.
4. Add a `<name>` option to `.github/workflows/load-test.yml` `scenario` input `choice`.
5. Add a bullet to this runbook.

## Not in scope

- **PROD load testing.** Spec explicitly punts to post-cutover.
- **Authenticated endpoints.** Everything hit is public.
- **Alerting integrations.** The CI workflow failure IS the alert.
- **Historical trend charts.** Pull artifacts from prior workflow runs (90 d retention).
```

- [ ] **Step 2: Register in VitePress sidebar**

The `predocs:build` guard rejects docs pages that aren't listed in the sidebar. Open `docs/.vitepress/config.ts`, find the "Operations" section under the developer sidebar, and add:

```typescript
{ text: 'Load testing', link: '/developers/operations/load-testing' },
```

Insert it alphabetically among the existing operations entries.

- [ ] **Step 3: Validate sidebar registration**

```bash
npm run docs:build 2>&1 | tail -20
```

Expected: build succeeds. The `predocs:build` check should not complain about `load-testing.md`. If it does, the sidebar entry didn't take.

- [ ] **Step 4: Commit**

```bash
git add docs/developers/operations/load-testing.md docs/.vitepress/config.ts
git commit -m "docs(#804): load-testing runbook + sidebar entry"
```

---

## Task 9: Test-load README

**Files:**
- Create: `test/load/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: contributor-facing quick-start.

- [ ] **Step 1: Create `test/load/README.md`**

```markdown
# test/load — k6 load-test suite

Quick start. Full docs: [docs/developers/operations/load-testing.md](../../docs/developers/operations/load-testing.md).

## Install k6

```
winget install k6.k6         # Windows
brew install k6              # macOS
```

Or use the pinned Docker image directly:

```
docker run --rm -i grafana/k6:0.51.0 run - < test/load/scenarios/01-smoke.js
```

## Run

```
npm run loadtest:smoke       # 30 s sanity check
npm run loadtest:baseline    # 2 min steady load
npm run loadtest:ramp        # 15 min — regressions only
npm run loadtest:tutorials   # HANA/LRU path, LOAD_MODE=hot|cold
npm run loadtest:ws          # Socket.IO handshake churn
```

Target another env with `LOAD_BASE_URL`. See config.js for all `LOAD_*` env vars.

## Do not

- Run in a `pre-commit` hook. Load runs take minutes.
- Run against PROD. Spec pins DEV-only for v1.
- Hardcode thresholds in scenario files. Thresholds live in `config.js`.
- Add a "run everything" script. Scenarios are intentionally separate.
```

- [ ] **Step 2: Commit**

```bash
git add test/load/README.md
git commit -m "docs(#804): test/load README (quick start)"
```

---

## Task 10: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/load-test.yml`

**Interfaces:**
- Consumes: `test/load/scenarios/*.js`, `LOAD_BASE_URL` repository variable.
- Produces: weekly artifact `k6-summary-<scenario>.json`.

- [ ] **Step 1: Create `.github/workflows/load-test.yml`**

```yaml
name: Load Test

on:
  schedule:
    # Monday 03:00 UTC — low-traffic window on DEV.
    - cron: '0 3 * * 1'
  workflow_dispatch:
    inputs:
      scenario:
        description: 'Which scenario to run'
        required: true
        default: smoke
        type: choice
        options:
          - smoke
          - baseline
          - ramp
          - tutorials
          - ws
          - all-except-ramp

concurrency:
  group: load-test
  cancel-in-progress: false

jobs:
  load-test:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Resolve LOAD_BASE_URL
        id: resolve
        env:
          REPO_LOAD_BASE_URL: ${{ vars.LOAD_BASE_URL }}
        run: |
          set -euo pipefail
          if [ -n "${REPO_LOAD_BASE_URL:-}" ]; then
            echo "base_url=$REPO_LOAD_BASE_URL" >> "$GITHUB_OUTPUT"
          else
            echo "base_url=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" >> "$GITHUB_OUTPUT"
          fi
          echo "srv_url=$(echo "${REPO_LOAD_BASE_URL:-https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com}" | sed 's/-tutorials-approuter/-tutorials-srv/')" >> "$GITHUB_OUTPUT"

      - name: Publish-in-flight guard
        id: guard
        env:
          SRV_URL: ${{ steps.resolve.outputs.srv_url }}
        run: |
          set -euo pipefail
          # If /content/hashes changes between two reads 10 s apart, a
          # publish is in flight and we bail out cleanly.
          first=$(curl -sf "$SRV_URL/content/hashes" -H 'Accept: application/json' \
            | jq -r '.manifestVersion // .version // "unknown"' 2>/dev/null || echo "unreachable")
          sleep 10
          second=$(curl -sf "$SRV_URL/content/hashes" -H 'Accept: application/json' \
            | jq -r '.manifestVersion // .version // "unknown"' 2>/dev/null || echo "unreachable")
          if [ "$first" = "unreachable" ] || [ "$second" = "unreachable" ]; then
            echo "::warning::/content/hashes unreachable — proceeding anyway"
            echo "skip=false" >> "$GITHUB_OUTPUT"
          elif [ "$first" != "$second" ]; then
            echo "::warning::Publish in flight ($first -> $second); skipping load test"
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Resolve scenarios to run
        id: scenarios
        if: steps.guard.outputs.skip != 'true'
        env:
          INPUT: ${{ inputs.scenario || 'baseline' }}
        run: |
          set -euo pipefail
          case "$INPUT" in
            smoke)     files='test/load/scenarios/01-smoke.js' ;;
            baseline)  files='test/load/scenarios/02-public-baseline.js' ;;
            ramp)      files='test/load/scenarios/03-public-ramp.js' ;;
            tutorials) files='test/load/scenarios/04-tutorial-serve.js' ;;
            ws)        files='test/load/scenarios/05-websocket-handshake.js' ;;
            all-except-ramp)
              files='test/load/scenarios/01-smoke.js test/load/scenarios/02-public-baseline.js test/load/scenarios/04-tutorial-serve.js test/load/scenarios/05-websocket-handshake.js'
              ;;
            *) echo "unknown scenario: $INPUT" >&2; exit 1 ;;
          esac
          {
            echo 'files<<EOF'
            echo "$files"
            echo 'EOF'
          } >> "$GITHUB_OUTPUT"

      - name: Run k6
        id: k6
        if: steps.guard.outputs.skip != 'true'
        env:
          LOAD_BASE_URL: ${{ steps.resolve.outputs.base_url }}
          LOAD_SRV_URL: ${{ steps.resolve.outputs.srv_url }}
          FILES: ${{ steps.scenarios.outputs.files }}
        run: |
          set -uo pipefail
          overall=0
          for f in $FILES; do
            name=$(basename "$f" .js)
            echo "::group::k6 run $f"
            docker run --rm \
              -v "$PWD:/work" -w /work \
              -e LOAD_BASE_URL \
              -e LOAD_SRV_URL \
              -e LOAD_SUMMARY_PATH="k6-summary-${name}.json" \
              grafana/k6:0.51.0 run "$f"
            rc=$?
            echo "::endgroup::"
            if [ $rc -ne 0 ]; then
              echo "::error::$f failed with exit $rc (threshold or execution)"
              overall=$rc
            fi
          done
          echo "rc=$overall" >> "$GITHUB_OUTPUT"

      - name: Upload k6 summary artifacts
        if: always() && steps.guard.outputs.skip != 'true'
        uses: actions/upload-artifact@v4
        with:
          name: k6-summaries
          path: k6-summary-*.json
          if-no-files-found: warn
          retention-days: 90

      - name: Fail loudly on threshold violation
        if: steps.guard.outputs.skip != 'true' && steps.k6.outputs.rc != '0'
        run: |
          echo "::error::One or more k6 runs exited non-zero — see 'k6 run' groups above."
          exit 1
```

- [ ] **Step 2: Lint the workflow syntax**

GitHub Actions has no local linter that ships in this repo, but a YAML parse-check catches gross mistakes:

```bash
yq '.' .github/workflows/load-test.yml >/dev/null
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/load-test.yml
git commit -m "ci(#804): weekly k6 load-test workflow with publish-in-flight guard"
```

---

## Task 11: CLAUDE.md gotcha

**Files:**
- Modify: `CLAUDE.md` — add one bullet in the Gotchas section.

**Interfaces:** none.

- [ ] **Step 1: Add the gotcha**

Open `CLAUDE.md`. Find the Gotchas section (the long bullet list starting with "Fresh worktree setup needs `npm run setup`…"). Add this bullet at the end of the list:

```markdown
- **Load tests (`test/load/`) are k6, not Vitest, and do NOT run on PRs** — five scenarios (`loadtest:smoke|baseline|ramp|tutorials|ws`) drive the deployed DEV AppRouter / srv. CI runs `.github/workflows/load-test.yml` weekly (Mon 03:00 UTC) + on manual dispatch — never on push/PR because DEV vCPU/HANA quota isn't free. Thresholds live in [test/load/config.js](test/load/config.js) `THRESHOLDS` only; never hardcode ms values in scenario files. The workflow aborts cleanly if `/content/hashes` shows a publish in flight. Full runbook: [docs/developers/operations/load-testing.md](docs/developers/operations/load-testing.md). Issue #804.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#804): CLAUDE.md gotcha for k6 load-test suite"
```

---

## Task 12: End-to-end smoke run

**Files:** none (verification only).

**Interfaces:** consumes all prior tasks.

- [ ] **Step 1: Run the smoke scenario locally if k6 is installed**

```bash
if command -v k6 >/dev/null 2>&1; then
  npm run loadtest:smoke
else
  docker run --rm -i -e LOAD_BASE_URL grafana/k6:0.51.0 run - < test/load/scenarios/01-smoke.js
fi
```

Expected: k6 prints a summary, `k6-summary.json` exists in cwd, exit 0.

If k6 is not installed AND Docker is not available, skip this step and note it in the PR body — the workflow's smoke run against DEV will validate on first dispatch.

- [ ] **Step 2: Trigger the CI smoke run against DEV**

Requires the PR branch to be pushed already. From the worktree:

```bash
git push
gh workflow run load-test.yml --ref "$(git rev-parse --abbrev-ref HEAD)" -f scenario=smoke
```

Then watch:

```bash
gh run watch --exit-status
```

Expected: green run, `k6-summaries` artifact uploaded.

- [ ] **Step 3: Download the artifact and eyeball**

```bash
gh run download --name k6-summaries
jq '.metrics["http_req_duration"].values["p(95)"], .metrics.http_req_failed.values.rate' k6-summary-01-smoke.json
```

Expected: two numbers. p95 in a plausible range (< 2 s), failure rate 0 or near 0.

- [ ] **Step 4: Ship the PR**

The draft PR (#965) is currently spec-only. Convert to ready-for-review after this task lands:

```bash
gh pr ready 965
```

---

## Self-review notes

- **Spec coverage:** every in-scope bullet from the spec's Scope section maps to a task. Directory structure (spec §Layout) → Tasks 1–6, package.json scripts → Task 7, runbook → Task 8, README → Task 9, workflow → Task 10, CLAUDE.md → Task 11.
- **Threshold table drift:** spec's threshold values (§2, §3, §4, §5) all mirrored in `test/load/config.js` `THRESHOLDS` (Task 1). Single source of truth.
- **Failure-mode guard:** publish-in-flight guard (spec §"Failure modes") implemented in Task 10 workflow.
- **Interface consistency:** `fetchSlugs(srvUrl)` returns `{tutorialSlugs, advocateSlugs}` in Task 1; Tasks 2–5 call it with `SRV_URL` and destructure the same shape. `getTagged(url, endpointLabel, extraParams)` signature consistent across all scenario files.
- **Open questions from spec (thresholds, cadence):** left as spec-level knobs. Both are one-line edits in the codebase (config.js for thresholds, workflow cron for cadence) — the plan doesn't lock them in.
