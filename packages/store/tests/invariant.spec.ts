/**
 * The package's invariant companion: it reserves the package name on the host's invariant service and
 * installs nothing (the store owns no harness-visible mutable value).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.ts'

const PACKAGE_NAME = 'dsh-plugin-dbgraph-store'

/** A context with the invariant service mounted, the way a host composition loads it. */
async function seam(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  return ctx
}

describe('store invariant companion', () => {
  it('names itself and declares its invariants dependency', () => {
    expect(name).toBe('dbgraph-store-invariant')
    expect(inject).toEqual(['invariants'])
  })

  it('registers the package invariant and hands back a working disposer', async () => {
    const ctx = await seam()
    const registerSpy = vi.spyOn(ctx.invariants, 'register')

    const dispose = await apply(ctx)

    expect(registerSpy).toHaveBeenCalledWith(PACKAGE_NAME, expect.any(Function))
    expect(dispose).toBeTypeOf('function')
    // The installer exists so the package can grow a real invariant later; today it must be a no-op.
    const installer = registerSpy.mock.calls[0]?.[1] as InvariantInstaller
    const fail = (message: string): never => {
      throw new Error(message)
    }
    expect(() => installer(ctx, fail)).not.toThrow()
    await dispose()
  })
})
