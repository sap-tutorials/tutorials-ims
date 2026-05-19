(function () {
  'use strict';

  const CONFIG_KEY = 'joule.config.v1';
  const HISTORY_KEY = 'joule.history';
  const USER_KEY = 'joule.user.v1';
  const CONFIG_TTL_MS = 60_000;
  const USER_TTL_MS = 60_000;

  const trigger = document.getElementById('joule-trigger');
  const panel = document.getElementById('joule-panel');
  if (!trigger || !panel) return;

  const transcript = panel.querySelector('.joule-panel__transcript');
  const banner = panel.querySelector('.joule-panel__banner');
  const form = panel.querySelector('.joule-panel__form');
  const input = panel.querySelector('.joule-panel__input');
  const closeBtn = panel.querySelector('.joule-panel__close');
  const hero = panel.querySelector('.joule-panel__hero');
  const chat = panel.querySelector('.joule-panel__chat');
  const heroGreeting = panel.querySelector('.joule-panel__hero-greeting');

  function showChat() { hero.hidden = true; chat.hidden = false; }
  function showHero() { hero.hidden = false; chat.hidden = true; }

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
    transcript.scrollTop = transcript.scrollHeight;
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
      if (r.redirected || !r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return null;
      const u = await r.json();
      if (!u.authenticated) return null;
      const cached = { firstName: u.givenName, familyName: u.familyName, email: u.email, id: u.id };
      sessionStorage.setItem(USER_KEY, JSON.stringify({ ts: Date.now(), value: cached }));
      return cached;
    } catch { return null; }
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
            window.__jouleRender.setMarkdown(assistantBubble, assistantText);
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

  async function open() {
    const user = await ensureAuth();
    if (!user) {
      const returnTo = location.pathname + location.search + (location.search ? '&' : '?') + 'joule=open';
      window.location.href = '/login?returnTo=' + encodeURIComponent(returnTo);
      return;
    }
    panel.hidden = false;
    const messages = loadHistory();
    if (messages.length) {
      showChat();
      renderTranscript(messages);
    } else {
      showHero();
      renderGreeting(user.firstName);
    }
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

    // Auto-open after login redirect: open() appends ?joule=open to returnTo,
    // so when XSUAA bounces the user back here, we re-enter the panel.
    const params = new URLSearchParams(location.search);
    if (params.get('joule') === 'open') {
      params.delete('joule');
      const cleaned = params.toString();
      history.replaceState(null, '', location.pathname + (cleaned ? '?' + cleaned : '') + location.hash);
      open();
    }
  });
})();
