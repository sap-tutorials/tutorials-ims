import { ref, type Ref } from 'vue'
import { csrfFetch } from '../api/csrf-fetch'

export type JouleMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'generated-query'; spec: any; sql: string; explanation: string; preview: any; errors: any[] }
  | { id: string; role: 'assistant'; kind: 'explanation'; summary: string; columns?: string[]; rows?: any[][] }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }

let _idSeq = 0
const nextId = () => `m${++_idSeq}`

// Module-singleton state — same panel state across all consumers in the SPA.
const messages: Ref<JouleMessage[]> = ref([])
const streaming = ref(false)
const error = ref<string | null>(null)
let abort: AbortController | null = null

async function send(prompt: string, pageContext: any) {
  if (streaming.value) return
  error.value = null
  messages.value.push({ id: nextId(), role: 'user', text: prompt })
  streaming.value = true
  abort = new AbortController()

  try {
    // Build the full conversation history for /chat/stream. Server expects
    // an array of { role, content } turns; we map our richer message shape
    // down. Tool-result envelopes stay client-side (server has its own loop).
    const wireMessages = messages.value
      .filter(m => m.role === 'user' || (m.role === 'assistant' && m.kind === 'text'))
      .map(m => ({
        role: m.role,
        content: m.role === 'user' ? (m as any).text : (m as any).text,
      }))
    const res: any = await csrfFetch('/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: wireMessages, pageContext }),
      signal: abort.signal,
    })

    if (!res.ok || !res.body) {
      messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: `HTTP ${res.status} ${res.statusText || ''}`.trim() })
      return
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let assistantTextMsg: JouleMessage | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const events = buf.split('\n\n')
      buf = events.pop() || ''
      for (const ev of events) {
        const line = ev.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const json = line.slice(6).trim()
        if (!json) continue
        let parsed: any
        try { parsed = JSON.parse(json) } catch { continue }
        if (parsed.type === 'delta') {
          const text = parsed.text || parsed.content || ''
          if (!assistantTextMsg) {
            assistantTextMsg = { id: nextId(), role: 'assistant', kind: 'text', text: '' }
            messages.value.push(assistantTextMsg)
          }
          // Mutate text in place — Vue 3's reactivity proxy picks up nested
          // property writes, and we avoid O(n²) array reallocation per token.
          ;(assistantTextMsg as any).text += text
        } else if (parsed.type === 'generated-query') {
          messages.value.push({ id: nextId(), role: 'assistant', kind: 'generated-query', spec: parsed.spec, sql: parsed.sql, explanation: parsed.explanation, preview: parsed.preview, errors: parsed.errors || [] })
          assistantTextMsg = null
        } else if (parsed.type === 'explanation') {
          messages.value.push({ id: nextId(), role: 'assistant', kind: 'explanation', summary: parsed.summary, columns: parsed.columns, rows: parsed.rows })
          assistantTextMsg = null
        } else if (parsed.type === 'error') {
          messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: parsed.message || parsed.reason || 'unknown error' })
        }
        // 'done' is a no-op; the loop ends when reader closes.
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      error.value = e.message
      messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: e.message })
    }
  } finally {
    streaming.value = false
    abort = null
  }
}

function cancel() { abort?.abort() }
function clear() { messages.value = []; error.value = null }

export function useJouleChat() {
  return { messages, streaming, error, send, cancel, clear }
}
