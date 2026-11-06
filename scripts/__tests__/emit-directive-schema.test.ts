import { describe, it, expect, beforeEach } from 'vitest'
import { emitDirectiveSchema } from '../emit-directive-schema'
import { registerDirective, resetRegistry, type DirectiveDef } from '../parsers/directive-registry'

describe('emitDirectiveSchema', () => {
  beforeEach(() => {
    resetRegistry()
  })

  it('returns valid JSON with an empty directives map when registry is empty', () => {
    const json = emitDirectiveSchema()
    const parsed = JSON.parse(json)

    expect(parsed).toHaveProperty('$schema')
    expect(parsed).toHaveProperty('$id')
    expect(parsed).toHaveProperty('directives')
    expect(parsed.directives).toEqual({})
  })

  it('includes a directive in the schema after it is registered', () => {
    const fixtureDef: DirectiveDef = {
      name: 'test-fixture',
      kinds: ['leaf', 'container'],
      summary: 'A test fixture directive',
      attrs: {
        title: {
          type: 'string',
          required: true,
        },
        count: {
          type: 'number',
          default: 1,
        },
      },
      since: '1.0.0',
      render: () => ({ markdown: 'test' }),
      toText: () => 'test',
    }

    registerDirective(fixtureDef)
    const json = emitDirectiveSchema()
    const parsed = JSON.parse(json)

    expect(parsed.directives).toHaveProperty('test-fixture')
    const directiveEntry = parsed.directives['test-fixture']
    expect(directiveEntry.name).toBe('test-fixture')
    expect(directiveEntry.kinds).toEqual(['leaf', 'container'])
    expect(directiveEntry.summary).toBe('A test fixture directive')
    expect(directiveEntry.attrs).toEqual({
      title: {
        type: 'string',
        required: true,
      },
      count: {
        type: 'number',
        default: 1,
      },
    })
    expect(directiveEntry.since).toBe('1.0.0')
  })

  it('includes optional fields (classes, label) when present', () => {
    const fixtureDef: DirectiveDef = {
      name: 'complex-directive',
      kinds: ['inline'],
      summary: 'A complex directive',
      label: {
        required: true,
        markdown: true,
      },
      attrs: {},
      classes: ['highlight', 'warning', 'info'],
      since: '2.0.0',
      render: () => ({ markdown: 'test' }),
      toText: () => 'test',
    }

    registerDirective(fixtureDef)
    const json = emitDirectiveSchema()
    const parsed = JSON.parse(json)

    const directiveEntry = parsed.directives['complex-directive']
    expect(directiveEntry.label).toEqual({
      required: true,
      markdown: true,
    })
    expect(directiveEntry.classes).toEqual(['highlight', 'warning', 'info'])
  })

  it('normalizes line endings to LF and includes trailing newline', () => {
    const json = emitDirectiveSchema()
    expect(json).toMatch(/\n$/)
    expect(json).not.toMatch(/\r\n/)
  })
})
