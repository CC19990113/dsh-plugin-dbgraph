/**
 * The shared thrown-value renderer. Every error message this package produces is built from it, so
 * the four shapes it accepts are pinned here rather than inferred from whichever call site happens to
 * run first.
 */

import { describe, expect, it } from 'vitest'
import { messageOf } from '../src/message.ts'

describe('messageOf', () => {
  it('reports an Error message verbatim', () => {
    expect(messageOf(new Error('the index is not readable'))).toBe('the index is not readable')
  })

  it('passes a thrown string through unchanged', () => {
    // A native addon or a plugin hook can reject with a bare string.
    expect(messageOf('native call failed')).toBe('native call failed')
  })

  it('serializes a thrown plain object', () => {
    expect(messageOf({ code: 7, reason: 'busy' })).toBe('{"code":7,"reason":"busy"}')
  })

  it('names the value JSON cannot represent', () => {
    expect(messageOf(undefined)).toBe('unknown error')
  })
})
