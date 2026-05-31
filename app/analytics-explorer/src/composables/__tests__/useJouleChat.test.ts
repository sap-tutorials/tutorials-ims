// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useJouleChat } from '../useJouleChat'

const encoder = new TextEncoder()
function sseStream(events: string[]) {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e))
      controller.close()
    },
  })
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async () => ({
    ok: true,
    body: sseStream([
      'data: {"type":"delta","text":"Hello "}\n\n',
      'data: {"type":"delta","text":"world"}\n\n',
      'data: {"type":"done"}\n\n',
    ]),
  } as any))
})
afterEach(() => vi.restoreAllMocks())

describe('useJouleChat', () => {
  it('streams delta chunks into a single assistant text message', async () => {
    const chat = useJouleChat()
    chat.clear()
    await chat.send('hi', { kind: 'admin', tool: 'analytics-builder' })
    expect(chat.messages.value).toHaveLength(2)
    expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'hi' })
    expect(chat.messages.value[1]).toMatchObject({ role: 'assistant', kind: 'text', text: 'Hello world' })
    expect(chat.streaming.value).toBe(false)
  })

  it('appends generated-query as its own message', async () => {
    vi.mocked(globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        'data: {"type":"delta","text":"Here you go: "}\n\n',
        'data: {"type":"generated-query","spec":{"version":1},"sql":"SELECT 1","explanation":"trivial","preview":{"columns":[],"rows":[],"truncated":false},"errors":[]}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    } as any)
    const chat = useJouleChat()
    chat.clear()
    await chat.send('build me one', { kind: 'admin', tool: 'analytics-builder' })
    const last = chat.messages.value[chat.messages.value.length - 1]
    expect(last.kind).toBe('generated-query')
    expect((last as any).sql).toBe('SELECT 1')
  })

  it('records error message on non-ok response', async () => {
    vi.mocked(globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom', body: null } as any)
    const chat = useJouleChat()
    chat.clear()
    await chat.send('hi', { kind: 'admin', tool: 'analytics-builder' })
    const last = chat.messages.value[chat.messages.value.length - 1]
    expect(last.kind).toBe('error')
    expect(chat.streaming.value).toBe(false)
  })
})
