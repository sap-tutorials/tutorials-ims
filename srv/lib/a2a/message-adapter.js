// srv/lib/a2a/message-adapter.js
// Translation layer between A2A protocol shapes and the internal chat
// orchestrator (#1220). Also provides an SSE shim so the existing
// streamChat({res,...}) can drive an A2A stream with NO changes to its
// internals — streamChat writes `data: {json}\n\n`; we intercept .write(),
// re-map each frame to an A2A event, and re-emit.

const CARD_FRAME_TYPES = new Set([
  'tutorial-cards', 'doc-citations', 'analytics-result', 'generated-query',
  'explanation', 'step-citations', 'external-content-cards', 'community-peers-cards',
]);

export function extractText(message) {
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts.filter(p => p && p.kind === 'text' && typeof p.text === 'string').map(p => p.text).join('');
}

export function a2aMessageToInternal(message) {
  return {
    messages: [{ role: 'user', content: extractText(message) }],
    pageContext: { kind: 'generic' },
  };
}

/** Map one internal orchestrator frame → an A2A event object, or null to swallow. */
export function mapFrame(frame, { taskId, contextId }) {
  if (!frame || typeof frame !== 'object') return null;
  const base = { taskId, contextId };
  if (frame.type === 'delta') {
    return { kind: 'status-update', ...base, status: { state: 'working', message: { role: 'agent', parts: [{ kind: 'text', text: frame.content ?? '' }] } }, final: false };
  }
  if (frame.type === 'done') {
    return { kind: 'status-update', ...base, status: { state: 'completed' }, final: true };
  }
  if (frame.type === 'error') {
    return { kind: 'status-update', ...base, status: { state: 'failed', message: { role: 'agent', parts: [{ kind: 'text', text: frame.reason || 'error' }] } }, final: true };
  }
  if (CARD_FRAME_TYPES.has(frame.type)) {
    return { kind: 'artifact-update', ...base, artifact: { name: frame.type, parts: [{ kind: 'data', data: frame }] } };
  }
  // 'tool' and anything else: swallow (not part of the A2A event surface).
  return null;
}

function writeEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/**
 * A `res`-like object streamChat can write to. Intercepts `.write()` of the
 * orchestrator's `data: {json}\n\n` frames, maps each to an A2A event, and
 * emits it on the real `res`. Header/lifecycle methods pass through.
 */
export function makeSseShim(realRes, { taskId, contextId, onFrame } = {}) {
  return {
    write(chunk) {
      // Single-frame assumption: streamChat's only writer (sse() in
      // chat-orchestrator.js) emits exactly one `data: {json}\n\n` per write.
      // A chunk carrying two concatenated frames would fail JSON.parse and
      // pass through untranslated — acceptable because that path never occurs.
      const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
      const line = s.startsWith('data: ') ? s.slice(6).trim() : null;
      if (line == null) { realRes.write(s); return true; }
      let frame;
      try { frame = JSON.parse(line); } catch { realRes.write(s); return true; }
      if (typeof onFrame === 'function') { try { onFrame(frame); } catch { /* non-fatal */ } }
      const ev = mapFrame(frame, { taskId, contextId });
      if (ev) writeEvent(realRes, ev);
      return true;
    },
    setHeader: (...a) => realRes.setHeader?.(...a),
    flushHeaders: () => realRes.flushHeaders?.(),
    flush: () => realRes.flush?.(),
    on: (...a) => realRes.on?.(...a),
    end: (...a) => realRes.end?.(...a),
    get headersSent() { return realRes.headersSent; },
  };
}

// FIX 2: extended to accept optional artifacts array. When non-empty the
// terminal task event carries the collected artifact objects so message/send
// callers receive card/citation artifacts alongside the accumulated text.
export function terminalTaskEvent({ taskId, contextId, state, text, artifacts }) {
  const ev = {
    kind: 'task', id: taskId, contextId,
    status: { state, message: text ? { role: 'agent', parts: [{ kind: 'text', text }] } : undefined },
  };
  if (Array.isArray(artifacts) && artifacts.length) ev.artifacts = artifacts;
  return ev;
}
