import { describe, expect, it } from 'vitest'
import { assertNever } from '../src/assert.ts'

// The helper exists for exhaustive switches, so every test calls it the way a default arm would:
// with a value the compiler only admits after the union has been narrowed to `never`. The casts are
// the point of the fixture — at runtime the value is a real, non-`never` thing.
describe('assertNever', () => {
  it('throws with the unreachable variant rendered as JSON', () => {
    expect(() => assertNever({ kind: 'triangle' } as never)).toThrowError(
      'unreachable variant: {"kind":"triangle"}',
    )
  })

  it('names the union when a context is supplied', () => {
    expect(() => assertNever('circle' as never, 'Shape')).toThrowError(
      'unreachable variant in Shape: "circle"',
    )
  })

  it('falls back to String() for a value JSON cannot render', () => {
    // `JSON.stringify(undefined)` is `undefined`, not the string "undefined".
    expect(() => assertNever(undefined as never)).toThrowError('unreachable variant: undefined')
  })
})
