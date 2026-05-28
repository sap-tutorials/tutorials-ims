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
      const opts = { starterContext: { kind: 'tutorial-step', vars: ctx || {} } };
      if (!this._ready) { this._pendingOpen = opts; return; }
      _openImpl(opts);
    },
    openWithMessage(arg) {
      const text = typeof arg === 'string' ? arg : (arg && typeof arg.text === 'string' ? arg.text : '');
      const opts = { autoSendText: text };
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
    return out;
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

    function ensureBubble() {
      if (assistantBubble) return assistantBubble;
      typingEl.remove();
      assistantBubble = appendMessage('assistant', '');
      return assistantBubble;
    }

    let res;
    try {
      res = await fetch('/chat/stream', {
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
      if (isStale()) return;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const evt of events) {
        if (isStale()) return;
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
            messages.push({ role: 'assistant', content: assistantText });
            saveHistory(messages);
          } else if (payload.type === 'error') {
            const bubble = ensureBubble();
            bubble.textContent = payload.reason === 'content_filter'
              ? "I can't help with that. Try asking about SAP tutorials."
              : 'Something went wrong. Please try again.';
            bubble.classList.add('joule-msg--error');
          }
        } catch { /* drop malformed event */ }
      }
    }
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
      // can lift it clear. IntersectionObserver is scoped to the row's
      // existence — pages without it (single tutorials, no prev/next) skip
      // the observer entirely.
      const navBottom = document.querySelector('.tutorial-nav-bottom');
      if (navBottom && 'IntersectionObserver' in window) {
        const navObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              stepFab.dataset.nearNavBottom = 'true';
            } else {
              delete stepFab.dataset.nearNavBottom;
            }
          }
        }, { rootMargin: '0px 0px 80px 0px' });
        navObserver.observe(navBottom);
      }
    }
    if (cfg.bannerText) { banner.textContent = cfg.bannerText; banner.hidden = false; }

    // Auto-open after login redirect: _openImpl() appends ?joule=open to returnTo,
    // so when XSUAA bounces the user back here, we re-enter the panel.
    const params = new URLSearchParams(location.search);
    if (params.get('joule') === 'open') {
      params.delete('joule');
      const cleaned = params.toString();
      history.replaceState(null, '', location.pathname + (cleaned ? '?' + cleaned : '') + location.hash);
      _openImpl();
    }

    window.joule._ready = true;
    if (window.joule._pendingOpen) {
      const pending = window.joule._pendingOpen;
      window.joule._pendingOpen = null;
      _openImpl(pending === true ? undefined : pending);
    }
  });
})();
