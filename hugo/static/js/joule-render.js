(function () {
  'use strict';
  if (!window.markdownit || !window.DOMPurify) {
    window.__jouleRender = { setMarkdown(t, s) { t.textContent = s || ''; } };
    return;
  }

  const md = window.markdownit({ html: false, linkify: true, breaks: true });

  function setMarkdown(target, source) {
    if (!source) { target.replaceChildren(); return; }
    const dirty = md.render(source);
    const clean = window.DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    target.replaceChildren(...doc.body.childNodes);
    target.querySelectorAll('a[href]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  window.__jouleRender = { setMarkdown };
})();
