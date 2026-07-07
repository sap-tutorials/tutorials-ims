(function () {
  'use strict';

  const CONFIG_KEY = 'joule.config.v1';
  const HISTORY_KEY = 'joule.history';
  const USER_KEY = 'joule.user.v1';
  const CONFIG_TTL_MS = 60_000;
  const USER_TTL_MS = 60_000;
  const STICK_THRESHOLD_PX = 80;

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  }

  function scrollToBottom(el, force = false) {
    if (force || isNearBottom(el)) el.scrollTop = el.scrollHeight;
  }

  // AppRouter's CSRF flow (re-enabled site-wide in #895). Any mutating request
  // against an XSUAA-authenticated route (e.g. POST /chat/stream) is rejected
  // by the approuter unless an `x-csrf-token` header accompanies it. This is
  // a hand-rolled copy of the two-step handshake — joule.js is plain non-module
  // JS in hugo/static/, so it can't import hugo-apps/src/shared/csrf-fetch.ts.
  // Behaviour must stay in sync with that module. Fixes #953-follow-up: the
  // navigator's new Joule button was the first surface to hit this hole,
  // showing up as a bare "POST /chat/stream 400" in the console.
  let _csrfToken = null;
  async function _fetchCsrfToken() {
    const res = await fetch('/auth/user', {
      method: 'GET',
      credentials: 'include',
      headers: { 'x-csrf-token': 'fetch' },
    });
    const token = res.headers.get('x-csrf-token');
    if (!res.ok || !token) throw new Error('csrf token unavailable');
    return token;
  }
  async function csrfFetch(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    // Safe methods: pass through — AppRouter never enforces CSRF here.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return fetch(url, { credentials: 'include', ...(init || {}) });
    }
    if (_csrfToken == null) _csrfToken = await _fetchCsrfToken();
    const merge = (extra) => {
      const h = new Headers((init && init.headers) || undefined);
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
      return h;
    };
    const first = await fetch(url, {
      credentials: 'include',
      ...(init || {}),
      headers: merge({ 'x-csrf-token': _csrfToken }),
    });
    if (first.status !== 403) return first;
    const required = (first.headers.get('x-csrf-token') || '').toLowerCase();
    if (required !== 'required') return first;
    // Token was stale — refetch once and retry.
    _csrfToken = null;
    _csrfToken = await _fetchCsrfToken();
    return fetch(url, {
      credentials: 'include',
      ...(init || {}),
      headers: merge({ 'x-csrf-token': _csrfToken }),
    });
  }

  // Sync-attach window.joule so UI5 controllers can call open() before
  // the async config load resolves.
  window.joule = {
    _ready: false,
    _pendingOpen: null,
    open(opts) {
      if (!this._ready) { this._pendingOpen = opts || true; return; }
      _openImpl(opts);
    },
    openWithStepContext(ctx) {
      const kind = ctx && ctx.branchContext ? 'tutorial-step-with-branch' : 'tutorial-step';
      const opts = { starterContext: { kind: kind, vars: ctx || {} } };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
    openWithMessage(arg) {
      const text = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : '');
      const opts = { autoSendText: text };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
    // #946: sibling of openWithMessage that pre-fills the composer WITHOUT
    // submitting. Opens Joule on the hero (or existing history) and drops
    // the prompt into the input so the user can edit before pressing send.
    // Optional focus hint: 'input' (default) leaves the caret in the input;
    // 'send' focuses the send button so pressing Enter/Space submits.
    openWithPrefill(arg) {
      const text = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : '');
      const focus = arg && arg.focus === 'send' ? 'send' : 'input';
      const opts = { prefillText: text, prefillFocus: focus };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
  };

  const trigger = document.getElementById('joule-trigger');
  const panel = document.getElementById('joule-panel');
  if (!panel) return;

  const transcript = panel.querySelector('.joule-panel__transcript');
  const body = panel.querySelector('.joule-panel__body');
  const banner = panel.querySelector('.joule-panel__banner');
  const form = panel.querySelector('.joule-panel__form');
  const input = panel.querySelector('.joule-panel__input');
  const closeBtn = panel.querySelector('.joule-panel__close');
  const hero = panel.querySelector('.joule-panel__hero');
  const chat = panel.querySelector('.joule-panel__chat');
  const heroGreeting = panel.querySelector('.joule-panel__hero-greeting');

  function showChat() { hero.hidden = true; chat.hidden = false; }
  function showHero() { hero.hidden = false; chat.hidden = true; }

  const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/i;

  function safeNavigate(type, slug) {
    if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) {
      LOG_NOOP();
      return;
    }
    const path = type === 'mission' ? `/missions/${slug}/`
               : type === 'group'   ? `/groups/${slug}/`
               :                      `/tutorials/${slug}/`;
    window.location.href = path;
  }

  // Inline log helper that won't pollute prod consoles; swap for console.warn during dev.
  function LOG_NOOP() {}

  function renderTutorialCards(items) {
    const wrap = document.createElement('div');
    wrap.className = 'joule-cards';
    for (const it of items) {
      if (!it || !SAFE_SLUG_RE.test(String(it.slug || ''))) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'joule-card';
      btn.dataset.slug = it.slug;
      btn.dataset.type = it.type || 'tutorial';

      const title = document.createElement('p');
      title.className = 'joule-card__title';
      title.textContent = it.title || it.slug;
      btn.appendChild(title);

      if (it.description) {
        const desc = document.createElement('p');
        desc.className = 'joule-card__desc';
        desc.textContent = it.description;
        btn.appendChild(desc);
      }
      if (it.primaryTag) {
        const tag = document.createElement('p');
        tag.className = 'joule-card__tag';
        tag.textContent = it.primaryTag;
        btn.appendChild(tag);
      }

      btn.addEventListener('click', () => safeNavigate(it.type, it.slug));
      wrap.appendChild(btn);
    }
    if (wrap.childElementCount > 0) {
      transcript.appendChild(wrap);
      scrollToBottom(body);
    }
  }

  function renderDocCitations(items) {
    const wrap = document.createElement('div');
    wrap.className = 'joule-doc-citations';
    const heading = document.createElement('p');
    heading.className = 'joule-doc-citations__heading';
    heading.textContent = 'Sources';
    wrap.appendChild(heading);
    const ul = document.createElement('ul');
    for (const it of items) {
      if (!it || typeof it.path !== 'string') continue;
      const li = document.createElement('li');
      const path = document.createElement('span');
      path.className = 'joule-doc-citations__path';
      path.textContent = it.path;
      li.appendChild(path);
      if (it.heading) {
        const sep = document.createTextNode(' — ');
        const h = document.createElement('span');
        h.className = 'joule-doc-citations__head';
        h.textContent = it.heading;
        li.appendChild(sep);
        li.appendChild(h);
      }
      ul.appendChild(li);
    }
    if (ul.childElementCount > 0) {
      wrap.appendChild(ul);
      transcript.appendChild(wrap);
      scrollToBottom(body);
    }
  }

  function renderStepCitations(items) {
    const wrap = document.createElement('div');
    wrap.className = 'joule-step-citations';
    const heading = document.createElement('p');
    heading.className = 'joule-step-citations__heading';
    heading.textContent = 'Tutorial steps';
    wrap.appendChild(heading);
    const ul = document.createElement('ul');
    for (const it of items) {
      if (!it || typeof it.tutorialSlug !== 'string' || typeof it.stepNumber !== 'number') continue;
      if (!SAFE_SLUG_RE.test(it.tutorialSlug)) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'joule-step-citations__link';
      a.href = `/tutorials/${it.tutorialSlug}/#step-${it.stepNumber}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `${it.tutorialTitle || it.tutorialSlug} — Step ${it.stepNumber}`;
      li.appendChild(a);
      if (typeof it.score === 'number') {
        const score = document.createElement('span');
        score.className = 'joule-step-citations__score';
        score.textContent = ` (${(it.score * 100).toFixed(0)}%)`;
        li.appendChild(score);
      }
      ul.appendChild(li);
    }
    if (ul.childElementCount > 0) {
      wrap.appendChild(ul);
      transcript.appendChild(wrap);
      scrollToBottom(body);
    }
  }

  function renderAnalyticsTable(parsed) {
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const wrap = document.createElement('div');
    wrap.className = 'joule-analytics';
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'joule-analytics__empty';
      empty.textContent = 'No rows returned.';
      wrap.appendChild(empty);
    } else {
      const cols = Object.keys(rows[0]);
      const table = document.createElement('table');
      table.className = 'joule-analytics__table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const c of cols) {
        const th = document.createElement('th');
        th.textContent = c;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const r of rows) {
        const tr = document.createElement('tr');
        for (const c of cols) {
          const td = document.createElement('td');
          const v = r[c];
          td.textContent = v == null ? '' : String(v);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    if (Number(parsed?.suppressedCount) > 0) {
      const note = document.createElement('p');
      note.className = 'joule-analytics__suppressed';
      note.textContent = `${parsed.suppressedCount} row(s) suppressed for privacy.`;
      wrap.appendChild(note);
    }
    transcript.appendChild(wrap);
    scrollToBottom(body);
  }

  let activeSendId = 0;

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

  function appendMessage(role, content, opts = {}) {
    const div = document.createElement('div');
    div.className = `joule-msg joule-msg--${role}`;
    if (role === 'assistant') window.__jouleRender.setMarkdown(div, content);
    else div.textContent = content;
    if (opts.id) div.dataset.id = opts.id;
    transcript.appendChild(div);
    scrollToBottom(body, true);
    return div;
  }

  function renderGreeting(firstName) {
    const fallback = heroGreeting.dataset.defaultGreeting || 'Hello, How can I help you?';
    heroGreeting.textContent = firstName ? `Hello ${firstName}, How can I help you?` : fallback;
  }

  function renderTranscript(messages) {
    transcript.replaceChildren();
    for (const m of messages) appendMessage(m.role, m.content);
  }

  function readPageContext() {
    const html = document.documentElement;
    if (html.dataset.pageKind === 'admin') {
      return {
        kind: 'admin',
        tool: html.dataset.adminTool || null,
        toolTitle: html.dataset.adminToolTitle || null,
        entity: html.dataset.adminEntityId ? {
          id: html.dataset.adminEntityId,
          type: html.dataset.adminEntityType || null,
          title: html.dataset.adminEntityTitle || null,
          slug: html.dataset.adminEntitySlug || null,
        } : null,
      };
    }

    if (html.dataset.pageKind === 'advocates') {
      // The advocates Vue island (hugo-apps/src/advocates/App.vue) stashes
      // the loaded roster on window.__JOULE_ADVOCATES after /api/advocates
      // resolves. We pass it through verbatim so the backend's advocatesLayer
      // can format it into the system prompt.
      return {
        kind: 'advocates',
        advocates: Array.isArray(window.__JOULE_ADVOCATES) ? window.__JOULE_ADVOCATES : [],
      };
    }

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
      const expanded = Array.from(document.querySelectorAll('.tutorial-step .step-body:not([hidden])'));
      if (expanded.length) {
        const firstStep = expanded[0].closest('.tutorial-step');
        const stepNum = Number(firstStep?.dataset.step);
        if (Number.isFinite(stepNum)) ctx.currentStep = stepNum;
        const titles = [];
        const textParts = [];
        let remaining = 4000;
        for (const body of expanded) {
          const stepEl = body.closest('.tutorial-step');
          const num = stepEl?.dataset.step;
          const heading = stepEl?.querySelector('.step-header-text')?.textContent?.trim();
          if (num && heading) titles.push(`Step ${num}: ${heading}`);
          if (remaining > 0) {
            const t = (body.textContent || '').replace(/\s+/g, ' ').trim();
            const slice = t.slice(0, remaining);
            if (slice) textParts.push(`[Step ${num}] ${slice}`);
            remaining -= slice.length;
          }
        }
        if (titles.length) ctx.expandedSteps = titles;
        if (textParts.length) ctx.currentStepText = textParts.join('\n\n');
      }
      // [#172 PR 4] Attach branchContext for the current step so the chat
      // orchestrator's tutorialLayer can append BRANCHING_GUIDANCE.
      if (ctx.currentStep && typeof window.opGetCurrentStepBranchContext === 'function') {
        const bc = window.opGetCurrentStepBranchContext(ctx.currentStep);
        if (bc) ctx.branchContext = bc;
      }
    }
    // [#172 PR 4] Attach altGroupsCount for collectionLayer to append BRANCHING_GUIDANCE.
    if (ctx.kind === 'mission' || ctx.kind === 'group') {
      const n = Number(html.dataset.altgroupsCount || '0');
      if (n > 0) ctx.altGroupsCount = n;
    }
    return ctx;
  }

  function readUser() {
    try { return JSON.parse(document.documentElement.dataset.user || 'null'); } catch { return null; }
  }

  function loadStarters() {
    try {
      const el = document.getElementById('joule-starters');
      return el ? JSON.parse(el.textContent) : {};
    } catch { return {}; }
  }

  function substituteStarter(text, vars) {
    let out = text;
    if (!vars || !vars.heading) {
      out = out.replace(/:\s*\{heading\}/g, '');
    }
    out = out.replace(/\{n\}/g, vars && vars.n != null ? String(vars.n) : '');
    out = out.replace(/\{heading\}/g, vars && vars.heading ? String(vars.heading) : '');

    // [#172 PR 4] Branch label substitutions. Lookup via tutorial-data JSON.
    if (vars && vars.branchContext) {
      const labels = lookupBranchLabels(vars.branchContext);
      out = out.replace(/\{currentLabel\}/g, labels.currentLabel || '');
      out = out.replace(/\{recommendedLabel\}/g, labels.recommendedLabel || '');
      out = out.replace(/\{branchLabel\}/g, labels.recommendedLabel || labels.currentLabel || '');
    } else {
      out = out.replace(/\{currentLabel\}|\{recommendedLabel\}|\{branchLabel\}/g, '');
    }
    return out;
  }

  function lookupBranchLabels(branchContext) {
    try {
      const dataEl = document.getElementById('tutorial-data');
      if (!dataEl) return {};
      let steps = JSON.parse(dataEl.textContent || '[]');
      if (typeof steps === 'string') steps = JSON.parse(steps);
      for (const step of steps) {
        if (step.branchPointId !== branchContext.branchPointId) continue;
        const branches = step.branches || [];
        const current = branches.find(b => b.key === branchContext.currentBranch);
        const recommended = branches.find(b => b.key === branchContext.recommendedBranch);
        return {
          currentLabel: current ? current.label : null,
          recommendedLabel: recommended ? recommended.label : null,
        };
      }
    } catch { /* ignore */ }
    return {};
  }

  function renderStarters(starterCtx) {
    const starters = loadStarters();
    let list;
    if (starterCtx && starterCtx.kind) {
      list = starters[starterCtx.kind] || starters.generic || [];
    } else {
      const ctx = readPageContext();
      list = starters[ctx.kind] || starters.generic || [];
    }
    const wrap = panel.querySelector('.joule-panel__starters');
    if (!wrap) return;
    wrap.replaceChildren();
    const vars = starterCtx && starterCtx.vars;
    if (vars && vars.branchContext &&
        vars.branchContext.currentBranch === vars.branchContext.recommendedBranch) {
      list = list.filter(t => !(t.includes('{currentLabel}') && t.includes('{recommendedLabel}')));
    }
    for (const text of list.slice(0, 3)) {
      const finalText = vars ? substituteStarter(text, vars) : text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'joule-panel__starter';
      btn.textContent = finalText;
      btn.addEventListener('click', () => { input.value = finalText; send(finalText); });
      wrap.appendChild(btn);
    }
  }

  function getCachedUser() {
    try {
      const raw = sessionStorage.getItem(USER_KEY);
      if (!raw) return null;
      const { ts, value } = JSON.parse(raw);
      if (Date.now() - ts > USER_TTL_MS) return null;
      return value;
    } catch { return null; }
  }

  async function fetchUser() {
    try {
      const r = await fetch('/auth/user', { credentials: 'include', redirect: 'follow' });
      if (r.redirected || !r.ok) { clearAuthCache(); return null; }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { clearAuthCache(); return null; }
      const u = await r.json();
      if (!u.authenticated) { clearAuthCache(); return null; }
      const cached = { firstName: u.givenName, familyName: u.familyName, email: u.email, id: u.id };
      sessionStorage.setItem(USER_KEY, JSON.stringify({ ts: Date.now(), value: cached }));
      return cached;
    } catch { return null; }
  }

  function clearAuthCache() {
    try {
      sessionStorage.removeItem(USER_KEY);
      sessionStorage.removeItem(HISTORY_KEY);
    } catch {}
  }

  async function ensureAuth() {
    if (document.documentElement.dataset.authenticated === 'true') {
      const fromHeader = readUser();
      if (fromHeader) return fromHeader;
    }
    const cached = getCachedUser();
    if (cached) return cached;
    return await fetchUser();
  }

  async function send(messageText) {
    showChat();
    const sendId = ++activeSendId;
    const isStale = () => sendId !== activeSendId;
    const messages = loadHistory();
    messages.push({ role: 'user', content: messageText });
    renderTranscript(messages);
    saveHistory(messages);

    const typingEl = document.createElement('div');
    typingEl.className = 'joule-typing';
    typingEl.setAttribute('role', 'status');
    typingEl.setAttribute('aria-label', 'Joule is thinking');
    for (let i = 0; i < 3; i++) typingEl.appendChild(document.createElement('span'));
    transcript.appendChild(typingEl);
    scrollToBottom(body, true);

    let assistantBubble = null;
    let assistantText = '';
    const toolChips = [];

    function ensureBubble() {
      if (assistantBubble) return assistantBubble;
      typingEl.remove();
      assistantBubble = appendMessage('assistant', '');
      return assistantBubble;
    }

    // Transient "Searching for X…" breadcrumbs emitted on tool frames should
    // disappear once the assistant's turn ends — leaving them wedged next to
    // the final answer clutters the transcript on every subsequent turn.
    function clearToolChips() {
      while (toolChips.length) toolChips.pop().remove();
    }

    let res;
    try {
      res = await csrfFetch('/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, pageContext: readPageContext() })
      });
    } catch {
      const bubble = ensureBubble();
      bubble.textContent = 'Network error. Please try again.';
      bubble.classList.add('joule-msg--error');
      return;
    }

    if (res.status === 401) { typingEl.remove(); window.location.href = '/login?returnTo=' + encodeURIComponent(location.pathname); return; }
    if (res.status === 503) { const bubble = ensureBubble(); bubble.textContent = 'Joule is currently unavailable.'; bubble.classList.add('joule-msg--error'); return; }
    if (res.status === 429) { const bubble = ensureBubble(); bubble.textContent = "You've reached today's chat limit."; bubble.classList.add('joule-msg--error'); return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (isStale()) { clearToolChips(); return; }
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const evt of events) {
        if (isStale()) { clearToolChips(); return; }
        const line = evt.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim());
          if (payload.type === 'delta') {
            assistantText += payload.content;
            window.__jouleRender.setMarkdown(ensureBubble(), assistantText);
            scrollToBottom(body);
          } else if (payload.type === 'tool') {
            typingEl.remove();
            const chip = document.createElement('div');
            chip.className = 'joule-tool-chip';
            chip.textContent = `Searching for ${payload.args?.query || '…'}`;
            transcript.insertBefore(chip, assistantBubble);
            toolChips.push(chip);
          } else if (payload.type === 'tutorial-cards') {
            if (Array.isArray(payload.items) && payload.items.length) {
              renderTutorialCards(payload.items);
            }
          } else if (payload.type === 'doc-citations') {
            if (Array.isArray(payload.items) && payload.items.length) {
              renderDocCitations(payload.items);
            }
          } else if (payload.type === 'step-citations') {
            if (Array.isArray(payload.items) && payload.items.length) {
              renderStepCitations(payload.items);
            }
          } else if (payload.type === 'analytics-result') {
            renderAnalyticsTable(payload);
          } else if (payload.type === 'done') {
            typingEl.remove();
            clearToolChips();
            messages.push({ role: 'assistant', content: assistantText });
            saveHistory(messages);
          } else if (payload.type === 'error') {
            clearToolChips();
            const bubble = ensureBubble();
            bubble.textContent = payload.reason === 'content_filter'
              ? "I can't help with that. Try asking about SAP tutorials."
              : 'Something went wrong. Please try again.';
            bubble.classList.add('joule-msg--error');
          }
        } catch { /* drop malformed event */ }
      }
    }
    // Belt-and-suspenders: if the stream ended without a `done`/`error` frame
    // (server crash, dropped connection), sweep any orphan chips before we
    // return so the transcript is clean for the next turn.
    clearToolChips();
  }

  async function _openImpl(opts) {
    const user = await ensureAuth();
    if (!user) {
      const returnTo = location.pathname + location.search + (location.search ? '&' : '?') + 'joule=open';
      window.location.href = '/login?returnTo=' + encodeURIComponent(returnTo);
      return;
    }
    panel.hidden = false;
    const messages = loadHistory();
    if (opts && typeof opts.autoSendText === 'string' && opts.autoSendText.length > 0) {
      // Skip hero/starters and send the seeded prompt immediately.
      send(opts.autoSendText);
      return;
    }
    if (messages.length) {
      showChat();
      renderTranscript(messages);
    } else {
      showHero();
      renderGreeting(user.firstName);
      renderStarters(opts && opts.starterContext);
    }
    // #946: prefill-without-send — drop text into the composer and focus per the
    // caller's hint. Runs AFTER the hero/chat swap so the input is actually
    // visible when focus() lands.
    if (opts && typeof opts.prefillText === 'string' && opts.prefillText.length > 0) {
      input.value = opts.prefillText;
      if (opts.prefillFocus === 'send') {
        const sendBtn = form.querySelector('.joule-panel__send');
        if (sendBtn) { sendBtn.focus(); return; }
      }
      input.focus();
      // Move caret to end so the user can keep typing or edit inline.
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch { /* ignore */ }
      return;
    }
    input.focus();
  }
  function close() { panel.hidden = true; }

  if (trigger) { trigger.addEventListener('click', () => window.joule.open()); }
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    send(msg);
  });

  const expandBtn = panel.querySelector('[data-action="expand"]');
  expandBtn.addEventListener('click', () => {
    const expanded = panel.dataset.expanded === 'true';
    panel.dataset.expanded = expanded ? 'false' : 'true';
    expandBtn.setAttribute('aria-label', expanded ? 'Expand' : 'Collapse');
  });

  const overflowBtn = panel.querySelector('[data-action="overflow"]');
  const overflowMenu = panel.querySelector('.joule-panel__overflow');

  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !overflowMenu.hidden;
    overflowMenu.hidden = open;
    overflowBtn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', (e) => {
    if (!overflowMenu.hidden && !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
      overflowMenu.hidden = true;
      overflowBtn.setAttribute('aria-expanded', 'false');
    }
  });

  overflowMenu.querySelector('[data-overflow="clear"]').addEventListener('click', () => {
    sessionStorage.removeItem(HISTORY_KEY);
    transcript.replaceChildren();
    showHero();
    overflowMenu.hidden = true;
    overflowBtn.setAttribute('aria-expanded', 'false');
  });

  const aiNoticeEl = panel.querySelector('.joule-panel__ai-notice');
  const footerEl = panel.querySelector('.joule-panel__footer');

  function showAINotice() {
    hero.hidden = true;
    chat.hidden = true;
    aiNoticeEl.hidden = false;
    footerEl.hidden = true;
  }

  function hideAINotice() {
    aiNoticeEl.hidden = true;
    footerEl.hidden = false;
    const hasHistory = (loadHistory() || []).length > 0;
    if (hasHistory) showChat(); else showHero();
  }

  overflowMenu.querySelector('[data-overflow="ai-notice"]').addEventListener('click', () => {
    showAINotice();
    overflowMenu.hidden = true;
    overflowBtn.setAttribute('aria-expanded', 'false');
  });

  panel.querySelector('[data-action="ai-notice-back"]').addEventListener('click', hideAINotice);

  loadConfig().then(cfg => {
    const stepFab = document.getElementById('joule-step-fab');
    if (!cfg.enabled) {
      if (trigger) trigger.remove();
      if (stepFab) stepFab.remove();
      return;
    }
    if (trigger) trigger.hidden = false;
    if (stepFab) {
      stepFab.hidden = false;
      stepFab.addEventListener('click', () => {
        const ctx = (typeof window.opGetCurrentStep === 'function')
          ? window.opGetCurrentStep()
          : { slug: '', n: 1, heading: '' };
        window.joule.openWithStepContext(ctx);
      });
      // Issue #102: tutorials reached via mission/group ordering render an
      // in-flow Previous/Next nav row at the bottom of the page that overlaps
      // the fixed-positioned FAB at viewport bottom. When the row scrolls into
      // view, set [data-near-nav-bottom] on the FAB so the matching CSS rule
      // can lift it clear.
      //
      // Issue #456: tutorials assigned to a mission/group ALSO render a
      // "Next Steps" card (.next-steps with .next-steps-card inside) that
      // sits visually ABOVE the .tutorial-nav-bottom row. The card is wider
      // and reaches the right edge of the content column, so it overlaps
      // the bottom-right FAB BEFORE the prev/next nav row does. Observing
      // only .tutorial-nav-bottom missed this case — the card was already
      // half-visible by the time the lift fired.
      //
      // Fix: observe BOTH elements with a SHARED observer. Either one
      // intersecting triggers the lift; both clearing lifts the FAB back
      // down. The shared observer also coalesces the two callbacks so we
      // don't thrash data-near-nav-bottom on mixed-visibility transitions.
      //
      // rootMargin pushes the trigger up by 160px so the lift completes
      // before either element visually meets the FAB. IntersectionObserver
      // is scoped to whichever targets actually exist — pages without
      // either (single tutorials, no prev/next, no recommendations) skip
      // the observer entirely.
      const navTargets = [
        document.querySelector('.tutorial-nav-bottom'),
        document.querySelector('.next-steps'),
      ].filter(Boolean);
      if (navTargets.length > 0 && 'IntersectionObserver' in window) {
        // Track which observed targets are currently intersecting so we can
        // toggle data-near-nav-bottom on the FAB based on ANY-intersecting,
        // not just the latest entry. Without this, a mixed-visibility batch
        // (e.g. next-steps leaves view while tutorial-nav-bottom enters)
        // could end with the wrong final state depending on iteration order.
        const intersecting = new WeakSet();
        const navObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              intersecting.add(entry.target);
            } else {
              intersecting.delete(entry.target);
            }
          }
          const anyVisible = navTargets.some((t) => intersecting.has(t));
          if (anyVisible) {
            stepFab.dataset.nearNavBottom = 'true';
          } else {
            delete stepFab.dataset.nearNavBottom;
          }
        }, { rootMargin: '0px 0px 160px 0px' });
        for (const target of navTargets) navObserver.observe(target);
      }
    }
    if (cfg.bannerText) { banner.textContent = cfg.bannerText; banner.hidden = false; }

    // Auto-open after login redirect: _openImpl() appends ?joule=open to returnTo,
    // so when XSUAA bounces the user back here, we re-enter the panel.
    // Also: ?joule_prompt=<text> opens Joule with a pre-filled prompt (used by
    // /explore/about/ #751). _openImpl's existing opts.autoSendText path skips
    // the hero/starters and sends the prompt immediately.
    const params = new URLSearchParams(location.search);
    if (params.get('joule') === 'open') {
      const prefillPrompt = params.get('joule_prompt') || null;
      params.delete('joule');
      params.delete('joule_prompt');
      const cleaned = params.toString();
      history.replaceState(null, '', location.pathname + (cleaned ? '?' + cleaned : '') + location.hash);
      if (prefillPrompt) {
        _openImpl({ autoSendText: prefillPrompt });
      } else {
        _openImpl();
      }
    }

    window.joule._ready = true;
    if (window.joule._pendingOpen) {
      const pending = window.joule._pendingOpen;
      window.joule._pendingOpen = null;
      _openImpl(pending === true ? undefined : pending);
    }
  });
})();
