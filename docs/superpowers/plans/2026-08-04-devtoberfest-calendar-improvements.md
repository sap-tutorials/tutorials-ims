# Devtoberfest Calendar Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the day-view thumbnail regression and enrich the Devtoberfest session calendar with planner-driven track colors, a richer detail panel (speaker info, inline video, LinkedIn, enlarge), and cached YouTube transcripts.

**Architecture:** A Vue island (`hugo-apps/src/devtoberfest-sessions-calendar/`) rendered by a Hugo layout, fed by custom Express routes (`srv/routes/devtoberfest-schedule.js`) over read-only cross-container HANA facades of the Devtoberfest Planner (`db/external/devtoberfest.cds`). Pure feed-shaping lives in `srv/lib/devtoberfest-feed.js`. Three slices land on one branch, verified locally, then deployed to DEV together.

**Tech Stack:** Vue 3 SFC + Vite (island), Node.js/Express + `@sap/cds` (routes), CDS/HANA facades, Vitest (`happy-dom` for components), native `fetch`.

**Companion spec:** `docs/superpowers/specs/2026-08-04-devtoberfest-calendar-improvements-design.md`

## Global Constraints

- **Node native `fetch`** only — no axios/node-fetch (project baseline Node 20+).
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query** — use raw `db.run()` with the BLOB isolated (LOB locators expire when mixed).
- **HANA columns are UPPERCASE** — facade element names and raw-SQL identifiers must match the deployed view contract.
- **Facade edits are cross-repo lockstep** — a `db/external/devtoberfest.cds` column must exist in the planner's deployed `DTF_*_V1` view first, or srv boot crashes at MTA deploy.
- **Run `npx cds deploy --to sqlite::memory:`** before committing any `db/**/*.cds` change; **`cds build --production`** (not `cds compile`) after schema changes for `db/last-dev/`.
- **CSP is already correct for this work:** `img-src` allows `i.ytimg.com`; `frame-src` allows `www.youtube.com`. Do NOT introduce `img.youtube.com` or `youtube-nocookie.com`.
- **Island `.vue`/helper unit tests** use Vitest with `// @vitest-environment happy-dom` and `@vue/test-utils` `mount`.
- **Feed unit tests** import from `../../srv/lib/devtoberfest-feed.js` and pass uppercase-column fixtures (see `test/unit/devtoberfest-feed.test.js`).
- **Windows/CRLF:** keep line endings LF; don't let edits flip files to CRLF.
- **Commit frequently**, one deliverable per task. Do NOT deploy to DEV until all tasks pass locally.

---

## File Structure

**Slice 1 — detail panel + thumbnail fix**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/completion.ts` (thumbnail host fix)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/youtube.ts` (add `youtubeEmbedUrl`)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/types.ts` (Speaker type, Session fields)
- Modify: `srv/lib/devtoberfest-feed.js` (speakers join, linkedinUrl)
- Modify: `srv/routes/devtoberfest-schedule.js` (speaker queries + photo endpoint)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue` (speaker block, embed, LinkedIn, enlarge)
- Tests: `completion.thumb.test.ts`, `youtube.embed.test.ts`, `DetailPanel.*.test.ts` (island); `devtoberfest-feed.test.js`, `devtoberfest-schedule-route.test.js` (server)

**Slice 2 — planner track colors/emoji**
- Modify: `D:\projects\devtoberfest-planner\db\src\DTF_TRACK_V1.hdbview` (+COLOR,+EMOJI)
- Modify: `db/external/devtoberfest.cds` (Track facade +COLOR,+EMOJI)
- Modify: `srv/lib/devtoberfest-feed.js` (carry trackColor/trackEmoji)
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts` (name→palette map)

**Slice 3 — transcript**
- Create: `db/devtoberfest-transcript.cds` (DevtoberfestTranscript entity)
- Create: `srv/lib/devtoberfest-transcript.js` (fetch/parse adapter, pure-ish)
- Modify: `srv/routes/devtoberfest-schedule.js` (transcript endpoint)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue` (transcript UI + seek)
- Tests: `devtoberfest-transcript.test.js` (parser), route test, DetailPanel transcript test

---

## SLICE 1 — Session detail panel + thumbnail fix

### Task 1: Fix thumbnail host (item 2 root-cause fix)

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/completion.ts:12-15`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/completion.thumb.test.ts`

**Interfaces:**
- Produces: `youtubeThumb(url: string): string | null` — now returns an `i.ytimg.com` URL.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { youtubeThumb } from './completion';

describe('youtubeThumb', () => {
  it('builds an i.ytimg.com URL (img.youtube.com is CSP-blocked)', () => {
    const url = youtubeThumb('https://www.youtube.com/watch?v=Zmo7YU9BUlc');
    expect(url).toBe('https://i.ytimg.com/vi/Zmo7YU9BUlc/hqdefault.jpg');
  });

  it('returns null when no video id is present', () => {
    expect(youtubeThumb('https://example.com/not-a-video')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/completion.thumb.test.ts`
Expected: FAIL — current URL is `https://img.youtube.com/vi/…`.

- [ ] **Step 3: Change the host**

In `completion.ts`, change the `youtubeThumb` return line:

```ts
export function youtubeThumb(url: string): string | null {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/completion.thumb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/completion.ts hugo-apps/src/devtoberfest-schedule-shared/completion.thumb.test.ts
git commit -m "fix(devtoberfest): emit i.ytimg.com thumbnails (img.youtube.com is CSP-blocked)"
```

### Task 2: Add `youtubeEmbedUrl` helper

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/youtube.ts`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/youtube.embed.test.ts`

**Interfaces:**
- Consumes: `youtubeId(url: string): string | null` (existing).
- Produces: `youtubeEmbedUrl(url: string): string` — `https://www.youtube.com/embed/<id>` or `''`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { youtubeEmbedUrl } from './youtube';

describe('youtubeEmbedUrl', () => {
  it('builds a www.youtube.com/embed URL (host is in CSP frame-src)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=Zmo7YU9BUlc'))
      .toBe('https://www.youtube.com/embed/Zmo7YU9BUlc');
  });
  it('returns empty string when no id', () => {
    expect(youtubeEmbedUrl('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/youtube.embed.test.ts`
Expected: FAIL — `youtubeEmbedUrl is not a function`.

- [ ] **Step 3: Implement**

Append to `youtube.ts`:

```ts
export function youtubeEmbedUrl(url: string): string {
  const id = youtubeId(url);
  return id ? `https://www.youtube.com/embed/${id}` : '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/youtube.embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/youtube.ts hugo-apps/src/devtoberfest-schedule-shared/youtube.embed.test.ts
git commit -m "feat(devtoberfest): add youtubeEmbedUrl helper (www.youtube.com/embed)"
```

### Task 3: Extend feed types for speakers + LinkedIn + track color

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/types.ts`

**Interfaces:**
- Produces: `Speaker` interface; `Session` fields `speakers?`, `linkedinUrl?`, `trackColor?`, `trackEmoji?`.

- [ ] **Step 1: Add the types** (no test — type-only change verified by consumers compiling)

Edit `types.ts`. Add before `Feed`:

```ts
export interface Speaker { id: string; name: string; role?: string; company?: string; photoUrl?: string }
```

Extend the `Session` interface with (append inside the interface body):

```ts
  linkedinUrl?: string; speakers?: Speaker[]; trackColor?: string; trackEmoji?: string;
```

- [ ] **Step 2: Typecheck**

Run: `cd hugo-apps && npx vue-tsc --noEmit -p tsconfig.json` (or the project's typecheck script if present: `npm run -s typecheck`)
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/types.ts
git commit -m "feat(devtoberfest): add Speaker type + Session speaker/linkedin/color fields"
```

### Task 4: Join speakers + map LinkedIn in `assembleFeed`

**Files:**
- Modify: `srv/lib/devtoberfest-feed.js:13-38`
- Test: `test/unit/devtoberfest-feed.test.js`

**Interfaces:**
- Consumes (new inputs to `assembleFeed`): `speakers` (rows with `ID, FIRSTNAME, LASTNAME, ROLE, COMPANY`), `sessionSpeakers` (rows with `SESSION_ID, SPEAKER_ID, SPEAKERORDER`).
- Produces: each feed session gains `linkedinUrl: string`, `speakers: [{ id, name, role, company, photoUrl }]` (sorted by `SPEAKERORDER`). `photoUrl = '/api/devtoberfest/speaker/' + id + '/photo'`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/devtoberfest-feed.test.js` inside the `describe`:

```js
it('assembleFeed attaches ordered speakers and maps linkedinUrl', () => {
  const sess = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', WEEK: '1', LINKEDINURL: 'https://linkedin.com/in/x' }];
  const speakers = [
    { ID: 'sp2', FIRSTNAME: 'Bea', LASTNAME: 'Two', ROLE: 'Dev', COMPANY: 'SAP' },
    { ID: 'sp1', FIRSTNAME: 'Al', LASTNAME: 'One', ROLE: 'PM', COMPANY: 'SAP' },
  ];
  const sessionSpeakers = [
    { SESSION_ID: 's1', SPEAKER_ID: 'sp2', SPEAKERORDER: 2 },
    { SESSION_ID: 's1', SPEAKER_ID: 'sp1', SPEAKERORDER: 1 },
  ];
  const out = assembleFeed({ sessions: sess, activities: [], tracks, editions: [], activeEditionId: null, speakers, sessionSpeakers });
  const s = out.sessions[0];
  expect(s.linkedinUrl).toBe('https://linkedin.com/in/x');
  expect(s.speakers.map((sp) => sp.id)).toEqual(['sp1', 'sp2']); // ordered
  expect(s.speakers[0]).toEqual({ id: 'sp1', name: 'Al One', role: 'PM', company: 'SAP', photoUrl: '/api/devtoberfest/speaker/sp1/photo' });
});

it('assembleFeed defaults speakers to [] and linkedinUrl to empty when none', () => {
  const out = assembleFeed({ sessions: [{ ID: 's9', TITLE: 'X', TRACK_ID: 't1' }], activities: [], tracks, editions: [], activeEditionId: null });
  expect(out.sessions[0].speakers).toEqual([]);
  expect(out.sessions[0].linkedinUrl).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: FAIL — `speakers` undefined / `linkedinUrl` undefined.

- [ ] **Step 3: Implement**

In `devtoberfest-feed.js`, change the `assembleFeed` signature and add speaker maps:

```js
function assembleFeed({ sessions = [], activities = [], tracks = [], editions = [], activeEditionId = null, speakers = [], sessionSpeakers = [] }) {
  const trackById = new Map(tracks.map((t) => [t.ID, t]));
  const mapTrack = (id) => trackById.get(id) || {};
  const speakerById = new Map(speakers.map((sp) => [sp.ID, sp]));
  const speakersBySession = new Map();
  for (const link of sessionSpeakers) {
    const arr = speakersBySession.get(link.SESSION_ID) || [];
    arr.push(link);
    speakersBySession.set(link.SESSION_ID, arr);
  }
  const speakerFor = (sessionId) => (speakersBySession.get(sessionId) || [])
    .slice()
    .sort((a, b) => (a.SPEAKERORDER || 0) - (b.SPEAKERORDER || 0))
    .map((link) => {
      const sp = speakerById.get(link.SPEAKER_ID) || {};
      const name = `${sp.FIRSTNAME || ''} ${sp.LASTNAME || ''}`.trim();
      return { id: link.SPEAKER_ID, name, role: sp.ROLE || '', company: sp.COMPANY || '', photoUrl: `/api/devtoberfest/speaker/${link.SPEAKER_ID}/photo` };
    });
```

Then in the session `.map((s) => ({ … }))`, add these fields to the returned object:

```js
        linkedinUrl: s.LINKEDINURL || '',
        speakers: speakerFor(s.ID),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: PASS (all cases, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/devtoberfest-feed.js test/unit/devtoberfest-feed.test.js
git commit -m "feat(devtoberfest): join speakers + map linkedinUrl in schedule feed"
```

### Task 5: Query speakers in the schedule route + add photo endpoint

**Files:**
- Modify: `srv/routes/devtoberfest-schedule.js:40-59` (scheduleHandler), `:111-116` (register)
- Test: `test/unit/devtoberfest-schedule-route.test.js`

**Interfaces:**
- Consumes: `assembleFeed({ …, speakers, sessionSpeakers })` from Task 4.
- Produces: route `GET /api/devtoberfest/speaker/:id/photo` streaming the BLOB; feed now carries speakers.

- [ ] **Step 1: Write the failing test** (route registration + photo 404 path)

Read the existing `test/unit/devtoberfest-schedule-route.test.js` to match its bootstrap (it uses the fail-soft SQLite path). Add a test asserting the photo route is registered and returns 404 when the facade is unavailable (SQLite unit env):

```js
it('registers the speaker photo route and 404s when no photo', async () => {
  const res = await request(app).get('/api/devtoberfest/speaker/nope/photo');
  expect([404, 503]).toContain(res.status); // 503 when facade absent, 404 when present-but-empty
});
```

(If the existing test file uses a different harness than `supertest`, mirror that harness instead — do not introduce a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: FAIL — route not registered (404 from Express default, but assertion checks the handler path; if it already 404s generically, strengthen the assertion to check `res.headers['content-type']` is not the JSON error).

- [ ] **Step 3: Implement — speakers in scheduleHandler**

In `scheduleHandler`, after `sessions` are loaded, add (inside the same try):

```js
      const sessionIds = sessions.map((s) => s.ID);
      let sessionSpeakers = [];
      let speakers = [];
      if (sessionIds.length && ext.Sessionspeaker && ext.Speaker) {
        sessionSpeakers = await SELECT.from(ext.Sessionspeaker)
          .columns('SESSION_ID', 'SPEAKER_ID', 'SPEAKERORDER')
          .where({ SESSION_ID: { in: sessionIds } });
        const speakerIds = [...new Set(sessionSpeakers.map((l) => l.SPEAKER_ID))];
        speakers = speakerIds.length
          ? await SELECT.from(ext.Speaker).columns('ID', 'FIRSTNAME', 'LASTNAME', 'ROLE', 'COMPANY').where({ ID: { in: speakerIds } })
          : [];
      }
```

Then pass them to the feed:

```js
    return res.status(200).json(assembleFeed({ sessions, activities, tracks, editions, activeEditionId: editionId, speakers, sessionSpeakers }));
```

- [ ] **Step 4: Implement — photo endpoint**

Add a handler above `register`:

```js
async function speakerPhotoHandler(req, res) {
  try {
    await cds.connect.to('db');
    let ext;
    try { ext = cds.entities('external.devtoberfest'); } catch { ext = null; }
    if (!ext?.Speaker) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    const db = cds.db;
    // Raw SQL: never SELECT a HANA BLOB alongside metadata via CDS QL.
    const rows = await db.run(
      `SELECT PHOTO, PHOTOTYPE FROM ${db.entities['external.devtoberfest.Speaker'].name ? '"' + db.entities['external.devtoberfest.Speaker'].name + '"' : 'EXTERNAL_DEVTOBERFEST_SPEAKER'} WHERE ID = ?`,
      [req.params.id]
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    const buf = row && (row.PHOTO || row.photo);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', (row.PHOTOTYPE || row.phototype) || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).end(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    LOG.error('GET /api/devtoberfest/speaker/:id/photo failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
```

> **Implementer note:** confirm the physical BLOB read against real HANA in the hybrid test (Task 12). The exact raw-SQL table/synonym name for the facade must be verified at implementation time via `cds.db.entities` — do not hardcode a guessed name into production without the hybrid test passing.

Register it (anonymous, context middleware only):

```js
  app.get('/api/devtoberfest/speaker/:id/photo', _contextMw, speakerPhotoHandler);
```

And export it: add `speakerPhotoHandler` to the `export { … }` list.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/routes/devtoberfest-schedule.js test/unit/devtoberfest-schedule-route.test.js
git commit -m "feat(devtoberfest): query speakers in feed + stream speaker photos"
```

### Task 6: DetailPanel — speaker block, inline embed, LinkedIn

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.detail.test.ts`

**Interfaces:**
- Consumes: `youtubeEmbedUrl` (Task 2), `safeHref`/`youtubeThumb` (existing), `Session.speakers`/`linkedinUrl` (Tasks 3–4).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

const row = {
  id: 's1', kind: 'session', title: 'Test Session',
  youtubeUrl: 'https://www.youtube.com/watch?v=Zmo7YU9BUlc',
  linkedinUrl: 'https://linkedin.com/in/x',
  speakers: [{ id: 'sp1', name: 'Al One', role: 'PM', company: 'SAP', photoUrl: '/api/devtoberfest/speaker/sp1/photo' }],
};

describe('DetailPanel enrichments', () => {
  it('renders an inline youtube embed iframe', () => {
    const w = mount(DetailPanel, { props: { row } });
    const iframe = w.find('iframe.detail-panel__embed');
    expect(iframe.exists()).toBe(true);
    expect(iframe.attributes('src')).toBe('https://www.youtube.com/embed/Zmo7YU9BUlc');
  });
  it('renders a speaker with photo and name', () => {
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__speaker').text()).toContain('Al One');
    expect(w.find('.detail-panel__speaker img').attributes('src')).toBe('/api/devtoberfest/speaker/sp1/photo');
  });
  it('renders a LinkedIn link when present', () => {
    const w = mount(DetailPanel, { props: { row } });
    const link = w.find('a.detail-panel__link--linkedin');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://linkedin.com/in/x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.detail.test.ts`
Expected: FAIL — no iframe/speaker/linkedin elements yet.

- [ ] **Step 3: Implement**

In `DetailPanel.vue` `<script setup>`, import the embed helper and expose it + speakers:

```ts
import { youtubeThumb, safeHref } from './completion';
import { youtubeEmbedUrl } from './youtube';
```

Add a computed for the embed URL:

```ts
const embedUrl = computed(() => {
  const r = props.row as any;
  return r?.youtubeUrl ? youtubeEmbedUrl(r.youtubeUrl) : '';
});
```

In the template, replace the static `thumb` block with an embed when available (keep thumb as fallback when no embed). Insert the embed before `__body`:

```html
<div v-if="embedUrl" class="detail-panel__embed-wrap">
  <iframe class="detail-panel__embed" :src="embedUrl"
    title="Session video" loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</div>
<div v-else-if="thumb" class="detail-panel__thumb-wrap">
  <img :src="thumb" :alt="`Thumbnail for ${row.title}`" class="detail-panel__thumb" />
</div>
```

Add a speaker block at the top of `__body`:

```html
<div v-if="(row as any).speakers && (row as any).speakers.length" class="detail-panel__speakers">
  <div v-for="sp in (row as any).speakers" :key="sp.id" class="detail-panel__speaker">
    <img v-if="sp.photoUrl" :src="sp.photoUrl" :alt="sp.name" class="detail-panel__speaker-photo" loading="lazy" @error="onSpeakerPhotoError" />
    <div class="detail-panel__speaker-meta">
      <span class="detail-panel__speaker-name">{{ sp.name }}</span>
      <span v-if="sp.role || sp.company" class="detail-panel__speaker-role">{{ [sp.role, sp.company].filter(Boolean).join(' @ ') }}</span>
    </div>
  </div>
</div>
```

Add the LinkedIn link inside `__links` (after the YouTube link):

```html
<a v-if="(row as any).linkedinUrl" :href="safeHref((row as any).linkedinUrl)" target="_blank" rel="noopener noreferrer" class="detail-panel__link detail-panel__link--linkedin">LinkedIn</a>
```

Add the photo error handler in `<script setup>`:

```ts
function onSpeakerPhotoError(ev: Event) { (ev.target as HTMLImageElement).style.display = 'none'; }
```

Add minimal styles (`.detail-panel__embed-wrap` 16:9 responsive, `.detail-panel__embed` 100% w/h, `.detail-panel__speaker` flex row, circular `.detail-panel__speaker-photo`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.detail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.detail.test.ts
git commit -m "feat(devtoberfest): detail panel speaker block, inline embed, LinkedIn link"
```

### Task 7: DetailPanel — enlarge toggle

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.enlarge.test.ts`

**Interfaces:**
- Produces: an `expanded` UI state toggled by a header button; drawer gets `detail-panel__drawer--wide` class when expanded.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

const row = { id: 's1', kind: 'session', title: 'Test' };

describe('DetailPanel enlarge', () => {
  it('toggles wide class when the enlarge button is clicked', async () => {
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__drawer--wide').exists()).toBe(false);
    await w.find('button.detail-panel__enlarge').trigger('click');
    expect(w.find('.detail-panel__drawer--wide').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.enlarge.test.ts`
Expected: FAIL — no enlarge button.

- [ ] **Step 3: Implement**

In `<script setup>` add:

```ts
import { ref } from 'vue';
const expanded = ref(false);
function toggleExpand() {
  expanded.value = !expanded.value;
  try { sessionStorage.setItem('dtf-detail-expanded', expanded.value ? '1' : '0'); } catch {}
}
```

Initialize from sessionStorage at setup:

```ts
try { expanded.value = sessionStorage.getItem('dtf-detail-expanded') === '1'; } catch {}
```

Bind the drawer class and add the header button (before the close button):

```html
<div class="detail-panel__drawer" :class="{ 'detail-panel__drawer--wide': expanded }">
  ...
  <button class="detail-panel__enlarge" @click="toggleExpand" :aria-pressed="expanded" :aria-label="expanded ? 'Shrink panel' : 'Enlarge panel'">{{ expanded ? '⤡' : '⤢' }}</button>
```

Add style: `.detail-panel__drawer--wide { width: min(70vw, 100vw); }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.enlarge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.enlarge.test.ts
git commit -m "feat(devtoberfest): enlarge toggle on session detail panel"
```

---

## SLICE 2 — Planner track colors + emoji

### Task 8: Expose COLOR + EMOJI in the planner view (cross-repo, deploy first)

**Files:**
- Modify: `D:\projects\devtoberfest-planner\db\src\DTF_TRACK_V1.hdbview`

**Interfaces:**
- Produces: `DTF_TRACK_V1` gains `COLOR` and `EMOJI` columns from `DEVTOBERFEST_TRACK`.

- [ ] **Step 1: Edit the view** (append two columns; UPPERCASE identifiers)

```sql
VIEW "DTF_TRACK_V1" AS
  SELECT
         "ID" AS "ID",
         "CREATEDAT" AS "CREATEDAT",
         "CREATEDBY" AS "CREATEDBY",
         "MODIFIEDAT" AS "MODIFIEDAT",
         "MODIFIEDBY" AS "MODIFIEDBY",
         "EDITION_ID" AS "EDITION_ID",
         "NAME" AS "NAME",
         "DESCRIPTION" AS "DESCRIPTION",
         "DAYOFWEEK" AS "DAYOFWEEK",
         "ISACTIVITYTRACK" AS "ISACTIVITYTRACK",
         "ACRONYM" AS "ACRONYM",
         "COLOR" AS "COLOR",
         "EMOJI" AS "EMOJI"
  FROM "DEVTOBERFEST_TRACK"
```

- [ ] **Step 2: Build the planner locally to confirm the view compiles**

Run (in planner repo): `cd /d/projects/devtoberfest-planner && npx cds build --production`
Expected: build succeeds; `DTF_TRACK_V1` present in output with new columns.

- [ ] **Step 3: Commit in the planner repo**

```bash
cd /d/projects/devtoberfest-planner
git add db/src/DTF_TRACK_V1.hdbview
git commit -m "feat(views): expose Track COLOR + EMOJI in DTF_TRACK_V1 for calendar color-coding"
```

- [ ] **Step 4: Deploy the planner DB** (coordinate with Tom — this must land before Task 9 is deployed)

Deploy the planner per its runbook so the cross-container view updates in the shared HANA instance. **Do not proceed to deploying the tutorials-ims facade change until this view is live.** (Local unit/component work in Tasks 9–10 can proceed; only the *deploy* is gated.)

### Task 9: Mirror COLOR + EMOJI in the facade and carry through the feed

**Files:**
- Modify: `db/external/devtoberfest.cds:22-35` (Track facade)
- Modify: `srv/lib/devtoberfest-feed.js` (session trackColor/trackEmoji)
- Test: `test/unit/devtoberfest-feed.test.js`

**Interfaces:**
- Produces: each feed session gains `trackColor: string` (enum name e.g. `'Blue'`) and `trackEmoji: string`.

- [ ] **Step 1: Add facade columns**

In `db/external/devtoberfest.cds`, add to the `Track` entity (after `ACRONYM`):

```cds
      COLOR                 : String(16);
      EMOJI                 : String(8);
```

- [ ] **Step 2: Validate the model compiles**

Run: `npx cds deploy --to sqlite::memory:`
Expected: succeeds (facade is `@cds.persistence.exists`, so it must at least parse/compile cleanly).

- [ ] **Step 3: Write the failing feed test**

Add to `test/unit/devtoberfest-feed.test.js`:

```js
it('assembleFeed carries trackColor and trackEmoji onto sessions', () => {
  const colorTracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday', COLOR: 'Green', EMOJI: '🟢' }];
  const out = assembleFeed({ sessions: [{ ID: 's1', TITLE: 'X', TRACK_ID: 't1' }], activities: [], tracks: colorTracks, editions: [], activeEditionId: null });
  expect(out.sessions[0].trackColor).toBe('Green');
  expect(out.sessions[0].trackEmoji).toBe('🟢');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: FAIL — `trackColor` undefined.

- [ ] **Step 5: Implement**

In `assembleFeed`'s session map, add:

```js
        trackColor: mapTrack(s.TRACK_ID).COLOR || '',
        trackEmoji: mapTrack(s.TRACK_ID).EMOJI || '',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: PASS.

- [ ] **Step 7: Rebuild `db/last-dev` CSN** (facade change touches the model)

Run: `npx cds build --production`
Expected: `db/last-dev/csn.json` updates; no hdbmigrationtable hand-edits.

- [ ] **Step 8: Commit**

```bash
git add db/external/devtoberfest.cds srv/lib/devtoberfest-feed.js test/unit/devtoberfest-feed.test.js db/last-dev/
git commit -m "feat(devtoberfest): carry planner track COLOR/EMOJI through the schedule feed"
```

### Task 10: Map planner color enum to the calendar palette

**Files:**
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts`
- Test: `hugo-apps/src/devtoberfest-sessions-calendar/track-colors.test.ts`

**Interfaces:**
- Consumes: per-session `trackColor` enum names (`Green|Orange|Yellow|Blue|Red|Purple`).
- Produces: `buildTrackColorMap(tracks: { name: string; color?: string }[])` prefers the enum color; falls back to alphabetical-hash palette. Existing `legendFor` unchanged. **Note the signature change** from `string[]` to objects — update the caller in `App.vue`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildTrackColorMap, NAMED_PALETTE } from './track-colors';

describe('buildTrackColorMap with planner colors', () => {
  it('uses the enum color when present', () => {
    const map = buildTrackColorMap([{ name: 'ABAP', color: 'Green' }]);
    expect(map.get('ABAP')).toEqual(NAMED_PALETTE.Green);
  });
  it('falls back to hash palette when color missing', () => {
    const map = buildTrackColorMap([{ name: 'NoColor' }]);
    expect(map.get('NoColor')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/track-colors.test.ts`
Expected: FAIL — `NAMED_PALETTE` undefined and signature mismatch.

- [ ] **Step 3: Implement**

Add a named palette and rework `buildTrackColorMap`:

```ts
export const NAMED_PALETTE: Record<string, TrackColor> = {
  Blue:   { bg: '#eaf4ff', border: '#0a6ed1', text: '#08386b' },
  Green:  { bg: '#eafaf0', border: '#107e3e', text: '#0a5c2e' },
  Red:    { bg: '#fdeef2', border: '#d20a2e', text: '#8b0a20' },
  Orange: { bg: '#fef3e7', border: '#e76500', text: '#8a3d00' },
  Yellow: { bg: '#fdf6e3', border: '#b8860b', text: '#6b4e00' },
  Purple: { bg: '#f3edfb', border: '#7858a8', text: '#432c66' },
};

export function buildTrackColorMap(tracks: { name: string; color?: string }[]): Map<string, TrackColor> {
  const map = new Map<string, TrackColor>();
  const uncolored = tracks.filter((t) => t.name && !NAMED_PALETTE[t.color || '']);
  const distinct = [...new Set(uncolored.map((t) => t.name))].sort((a, b) => a.localeCompare(b, 'en'));
  const hashIndex = new Map<string, number>();
  distinct.forEach((name, i) => hashIndex.set(name, i));
  for (const t of tracks) {
    if (!t.name) continue;
    const named = NAMED_PALETTE[t.color || ''];
    map.set(t.name, named || PALETTE[(hashIndex.get(t.name) || 0) % PALETTE.length]);
  }
  return map;
}
```

- [ ] **Step 4: Update the caller in App.vue**

In `App.vue`, find where `buildTrackColorMap` is called with track names and change it to pass `{ name, color }` objects derived from the feed's sessions/tracks (use `trackName` + `trackColor`). Verify via the typecheck.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-sessions-calendar/track-colors.test.ts && npx vue-tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/devtoberfest-sessions-calendar/track-colors.ts hugo-apps/src/devtoberfest-sessions-calendar/track-colors.test.ts hugo-apps/src/devtoberfest-sessions-calendar/App.vue
git commit -m "feat(devtoberfest): color calendar tracks from planner COLOR enum with hash fallback"
```

---

## SLICE 3 — Transcript

### Task 11: DevtoberfestTranscript entity

**Files:**
- Create: `db/devtoberfest-transcript.cds`

**Interfaces:**
- Produces: entity `tutorials.devtoberfest.Transcript` (or match the project's db namespace) with keys/columns below.

- [ ] **Step 1: Create the entity**

```cds
namespace tutorials.devtoberfest;

entity Transcript {
  key videoId   : String(20);
      source    : String(10);   // 'uploaded' | 'auto' | 'none'
      lang      : String(10);
      segments  : LargeBinary;  // gzip of [{ start, text }]
      fetchedAt : Timestamp;
}
```

> **Implementer note:** confirm the correct db namespace/prefix used by the tutorials-ims project's own (non-facade) tables and match it, rather than inventing `tutorials.devtoberfest` if a different convention exists.

- [ ] **Step 2: Validate model compiles**

Run: `npx cds deploy --to sqlite::memory:`
Expected: succeeds; the entity is created.

- [ ] **Step 3: Rebuild db/last-dev**

Run: `npx cds build --production`
Expected: `db/last-dev/csn.json` + a new `.hdbtable` for Transcript.

- [ ] **Step 4: Commit**

```bash
git add db/devtoberfest-transcript.cds db/last-dev/
git commit -m "feat(devtoberfest): add Transcript entity for cached YouTube captions"
```

### Task 12: Transcript fetch/parse adapter

**Files:**
- Create: `srv/lib/devtoberfest-transcript.js`
- Test: `test/unit/devtoberfest-transcript.test.js`

**Interfaces:**
- Produces: `parseTimedText(xml: string): { start: number, text: string }[]` (pure); `pickCaptionTrack(list, { preferUploaded }): { url, kind } | null` (pure); `fetchTranscript(videoId): Promise<{ source, lang, segments }>` (impure, native fetch).

- [ ] **Step 1: Write the failing parser tests**

```js
import { describe, it, expect } from 'vitest';
import { parseTimedText, pickCaptionTrack } from '../../srv/lib/devtoberfest-transcript.js';

describe('parseTimedText', () => {
  it('parses <text start=..> nodes into {start,text}', () => {
    const xml = `<?xml version="1.0"?><transcript><text start="1.5" dur="2">Hello &amp; hi</text><text start="4" dur="1">World</text></transcript>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 1.5, text: 'Hello & hi' },
      { start: 4, text: 'World' },
    ]);
  });
  it('returns [] on empty/garbage', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText('not xml')).toEqual([]);
  });
});

describe('pickCaptionTrack', () => {
  it('prefers a non-asr (uploaded) track', () => {
    const list = [{ url: 'a', kind: 'asr' }, { url: 'b' }];
    expect(pickCaptionTrack(list, { preferUploaded: true })).toEqual({ url: 'b' });
  });
  it('falls back to asr when only auto captions exist', () => {
    const list = [{ url: 'a', kind: 'asr' }];
    expect(pickCaptionTrack(list, { preferUploaded: true })).toEqual({ url: 'a', kind: 'asr' });
  });
  it('returns null when list empty', () => {
    expect(pickCaptionTrack([], { preferUploaded: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/devtoberfest-transcript.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helpers + fetch adapter**

```js
// Fetch + parse YouTube captions. Uploaded preferred, auto (asr) fallback.
// The timedtext endpoint is undocumented; keep this behind one module so it
// can be swapped without touching the route/table. Uses native fetch.

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function parseTimedText(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const start = parseFloat(m[1]);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (text) out.push({ start, text });
  }
  return out;
}

function pickCaptionTrack(list, { preferUploaded = true } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  if (preferUploaded) {
    const uploaded = list.find((t) => t.kind !== 'asr');
    if (uploaded) return uploaded;
  }
  return list[0];
}

async function listCaptionTracks(videoId) {
  // timedtext track list (XML). Returns [{ url, kind, lang }].
  const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const tracks = [];
  const re = /<track[^>]*\blang_code="([^"]*)"[^>]*?(?:\bkind="([^"]*)")?[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const lang = m[1]; const kind = m[2] || '';
    const turl = `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}${kind ? `&kind=${kind}` : ''}`;
    tracks.push({ url: turl, kind, lang });
  }
  return tracks;
}

async function fetchTranscript(videoId) {
  const tracks = await listCaptionTracks(videoId);
  const chosen = pickCaptionTrack(tracks, { preferUploaded: true });
  if (!chosen) return { source: 'none', lang: '', segments: [] };
  const res = await fetch(chosen.url);
  if (!res.ok) return { source: 'none', lang: '', segments: [] };
  const segments = parseTimedText(await res.text());
  if (!segments.length) return { source: 'none', lang: chosen.lang || '', segments: [] };
  return { source: chosen.kind === 'asr' ? 'auto' : 'uploaded', lang: chosen.lang || '', segments };
}

export { parseTimedText, pickCaptionTrack, listCaptionTracks, fetchTranscript };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/devtoberfest-transcript.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/devtoberfest-transcript.js test/unit/devtoberfest-transcript.test.js
git commit -m "feat(devtoberfest): transcript fetch/parse adapter (uploaded → auto fallback)"
```

### Task 13: Transcript endpoint (cache-first)

**Files:**
- Modify: `srv/routes/devtoberfest-schedule.js`
- Test: `test/unit/devtoberfest-schedule-route.test.js`

**Interfaces:**
- Consumes: `fetchTranscript` (Task 12), `Transcript` entity (Task 11).
- Produces: `GET /api/devtoberfest/transcript?video=<id>` → `{ videoId, source, lang, segments }`.

- [ ] **Step 1: Write the failing test** (validation path — missing `video` param → 400)

```js
it('transcript endpoint 400s without a video id', async () => {
  const res = await request(app).get('/api/devtoberfest/transcript');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: FAIL — route not registered (404, not 400).

- [ ] **Step 3: Implement**

Import the adapter + gzip at the top of the route file:

```js
import { fetchTranscript } from '../lib/devtoberfest-transcript.js';
import { gzipSync, gunzipSync } from 'node:zlib';
```

Add the handler:

```js
const TRANSCRIPT_TTL_MS = 1000 * 60 * 60 * 24 * 7;   // 7d for real transcripts
const TRANSCRIPT_NONE_TTL_MS = 1000 * 60 * 60;        // 1h for negative cache

async function transcriptHandler(req, res) {
  const videoId = String(req.query.video || '').trim();
  if (!videoId) return res.status(400).json({ error: 'MISSING_VIDEO' });
  try {
    await cds.connect.to('db');
    const { Transcript } = cds.entities('tutorials.devtoberfest');
    const now = Date.now();
    const cached = await SELECT.one.from(Transcript).where({ videoId });
    if (cached) {
      const age = now - new Date(cached.fetchedAt).getTime();
      const ttl = cached.source === 'none' ? TRANSCRIPT_NONE_TTL_MS : TRANSCRIPT_TTL_MS;
      if (age < ttl) {
        const segments = cached.source === 'none' ? [] : JSON.parse(gunzipSync(cached.segments).toString('utf8'));
        return res.status(200).json({ videoId, source: cached.source, lang: cached.lang, segments });
      }
    }
    const fresh = await fetchTranscript(videoId);
    const blob = fresh.source === 'none' ? null : gzipSync(Buffer.from(JSON.stringify(fresh.segments), 'utf8'));
    await UPSERT.into(Transcript).entries({ videoId, source: fresh.source, lang: fresh.lang, segments: blob, fetchedAt: new Date().toISOString() });
    return res.status(200).json({ videoId, source: fresh.source, lang: fresh.lang, segments: fresh.segments });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/transcript failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
```

Register it (anonymous):

```js
  app.get('/api/devtoberfest/transcript', _contextMw, transcriptHandler);
```

Add `transcriptHandler` to the exports.

> **Implementer note:** verify `UPSERT.into` on a HANA BLOB column behaves in the hybrid test; if the gzip Buffer needs base64 for the CDS binding, adjust in Task 15's hybrid run (unit SQLite may accept the Buffer directly).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-schedule-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-schedule.js test/unit/devtoberfest-schedule-route.test.js
git commit -m "feat(devtoberfest): cache-first transcript endpoint"
```

### Task 14: DetailPanel — transcript UI + seek

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue`
- Test: `hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.transcript.test.ts`

**Interfaces:**
- Consumes: `GET /api/devtoberfest/transcript` (Task 13), the embed iframe (Task 6).

- [ ] **Step 1: Write the failing test** (mock fetch; assert lazy load + line render + seek postMessage)

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

const row = { id: 's1', kind: 'session', title: 'T', youtubeUrl: 'https://www.youtube.com/watch?v=Zmo7YU9BUlc' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ videoId: 'Zmo7YU9BUlc', source: 'auto', lang: 'en', segments: [{ start: 12, text: 'hello' }] }),
  })));
});

describe('DetailPanel transcript', () => {
  it('loads and renders transcript lines when expanded', async () => {
    const w = mount(DetailPanel, { props: { row } });
    await w.find('button.detail-panel__enlarge').trigger('click');
    await w.find('button.detail-panel__transcript-toggle').trigger('click');
    await flushPromises();
    expect(w.find('.detail-panel__transcript').text()).toContain('hello');
    expect(w.find('.detail-panel__transcript').text()).toContain('auto-generated');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.transcript.test.ts`
Expected: FAIL — no transcript toggle/section.

- [ ] **Step 3: Implement**

Add state + loader in `<script setup>`:

```ts
import { youtubeId } from './youtube';
const transcript = ref<{ start: number; text: string }[]>([]);
const transcriptSource = ref('');
const transcriptOpen = ref(false);
const transcriptLoaded = ref(false);
async function toggleTranscript() {
  transcriptOpen.value = !transcriptOpen.value;
  if (transcriptOpen.value && !transcriptLoaded.value) {
    const id = youtubeId((props.row as any)?.youtubeUrl || '');
    if (!id) { transcriptLoaded.value = true; return; }
    try {
      const r = await fetch(`/api/devtoberfest/transcript?video=${encodeURIComponent(id)}`);
      const data = await r.json();
      transcript.value = data.segments || [];
      transcriptSource.value = data.source || '';
    } catch { transcript.value = []; }
    transcriptLoaded.value = true;
  }
}
function fmtTs(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }
function seekTo(sec: number) {
  const iframe = document.querySelector('iframe.detail-panel__embed') as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [sec, true] }), '*');
}
```

Add `enablejsapi=1` to the embed src (adjust Task 6's `embedUrl`):

```ts
const embedUrl = computed(() => {
  const r = props.row as any;
  const base = r?.youtubeUrl ? youtubeEmbedUrl(r.youtubeUrl) : '';
  return base ? `${base}?enablejsapi=1` : '';
});
```

Add the transcript section (only meaningful when expanded — show the toggle whenever there's a video):

```html
<div v-if="embedUrl" class="detail-panel__transcript-wrap">
  <button class="detail-panel__transcript-toggle" @click="toggleTranscript" :aria-expanded="transcriptOpen">
    {{ transcriptOpen ? 'Hide transcript' : 'Show transcript' }}
  </button>
  <div v-if="transcriptOpen" class="detail-panel__transcript">
    <p v-if="transcriptLoaded && !transcript.length" class="detail-panel__transcript-empty">Transcript not available.</p>
    <p v-if="transcriptSource === 'auto'" class="detail-panel__transcript-tag">auto-generated</p>
    <button v-for="(seg, i) in transcript" :key="i" class="detail-panel__transcript-line" @click="seekTo(seg.start)">
      <span class="detail-panel__transcript-ts">{{ fmtTs(seg.start) }}</span>
      <span>{{ seg.text }}</span>
    </button>
  </div>
</div>
```

Add scrollable styles for `.detail-panel__transcript` (max-height, overflow-y).

- [ ] **Step 4: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/DetailPanel.transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.vue hugo-apps/src/devtoberfest-schedule-shared/DetailPanel.transcript.test.ts
git commit -m "feat(devtoberfest): clickable, seekable transcript in detail panel"
```

---

## SLICE-WIDE VERIFICATION (before any DEV deploy)

### Task 15: Full local + hybrid verification

- [ ] **Step 1: Run the full island test suite**

Run: `cd hugo-apps && npm test`
Expected: all pass (no `@mediapipe` resolution errors — if so, run `npm run setup` from repo root first).

- [ ] **Step 2: Run the server unit suite**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js test/unit/devtoberfest-schedule-route.test.js test/unit/devtoberfest-transcript.test.js`
Expected: all pass.

- [ ] **Step 3: Hybrid tests against real HANA** (requires `cf login`; planner view from Task 8 must be deployed)

Run: `npm run test:hybrid -- --project hybrid` (or the project's canonical hybrid invocation)
Verify: speaker photo endpoint streams a real BLOB with correct content-type; feed carries speakers + trackColor; transcript endpoint stores/reads the gzip BLOB.

- [ ] **Step 4: Build the islands + full site**

Run (repo root): `npm run build:all`
Expected: succeeds; confirm the built `hugo/static/js/chunks/DetailPanel-*.js` contains `i.ytimg.com/vi/` and `www.youtube.com/embed`.

- [ ] **Step 5: Real-thing browser verification (Tom's #1 rule)**

Against a local `dev:hybrid` (or after deploy to DEV once approved): open `/devtoberfest/calendar/`, switch to Day view on the session with a YouTube URL, confirm the thumbnail renders (no placeholder). Open the detail panel: confirm speaker photo, LinkedIn link, inline video plays, enlarge widens the panel, transcript loads and a click seeks the video.

- [ ] **Step 6: Final branch review + PR**

Use `superpowers:requesting-code-review`, then open a PR (never direct-merge to main). Do not deploy to DEV until all three slices' tasks are complete and green.

---

## Self-Review

**Spec coverage:**
- Item 1 (track colors from planner) → Tasks 8–10. ✓ (emoji included)
- Item 2 (day-view thumbnails) → Task 1 (CSP host fix; DayAgenda render already correct). ✓
- Item 3 (detail panel: thumbnail, speaker+photo, LinkedIn, embed, enlarge) → Tasks 2–7. ✓
- Item 4 (transcript, uploaded→auto, cached, clickable-seek) → Tasks 11–14. ✓
- Speaker photo dedicated endpoint → Task 5. ✓
- LinkedIn session-level → Task 4/6. ✓
- Deploy gating (all slices before DEV) → Task 15. ✓

**Placeholder scan:** No TBD/TODO. Two explicit "Implementer note" callouts flag facts to verify at implementation time (raw-SQL facade table name; db namespace; BLOB binding) rather than guessing — these are verification instructions, not placeholders.

**Type consistency:** `youtubeThumb`/`youtubeEmbedUrl`/`youtubeId` names consistent across tasks; `assembleFeed` input names (`speakers`, `sessionSpeakers`) consistent Task 4↔5; `buildTrackColorMap` signature change from `string[]`→objects flagged with its caller update (Task 10 Step 4); `Transcript` entity fields consistent Task 11↔13.
