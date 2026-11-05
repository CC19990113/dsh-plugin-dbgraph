import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseDialect, Engine } from 'dsh-plugin-dbgraph-service'
import type { ManagedDialect } from '../src/support.ts'
import { apply } from '../src/index.ts'

/**
 * `apply` has to survive a dialect that cannot load, and it can only do that through the two
 * factories in `DIALECT_FACTORIES`. Replacing them is how this file forces a load failure the
 * installation cannot produce on demand; `plugin.spec.ts` keeps exercising the real factories.
 */
const control = vi.hoisted(() => ({
  sqlite: { mode: 'ok' as 'ok' | 'fail', closeFails: false },
  mysql: { mode: 'ok' as 'ok' | 'fail' },
}))

/**
 * One dialect stub, built inside a mock factory because `vi.mock` bodies are hoisted.
 * @param engine - the engine the stub serves.
 * @param closeFails - whether disposal must report a failure.
 * @returns the stub dialect.
 */
function stubDialect(engine: Engine, closeFails: boolean): ManagedDialect {
  return {
    engine,
    test: async () => ({ ok: true, elapsedMs: 0 }),
    fetchL1: async () => {
      throw new Error('unused')
    },
    fetchL2: async () => {
      throw new Error('unused')
    },
    execute: async () => {
      throw new Error('unused')
    },
    close: async () => {
      if (closeFails) throw new Error(`${engine} close failed`)
    },
  }
}

vi.mock('../src/sqlite.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sqlite.ts')>()
  return {
    ...actual,
    createSqliteDialect: () => {
      if (control.sqlite.mode === 'fail') throw new Error('node:sqlite is unavailable')
      return stubDialect('sqlite', control.sqlite.closeFails)
    },
  }
})

vi.mock('../src/mysql.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mysql.ts')>()
  const fail = (): never => {
    throw new Error('mysql2 is not installed')
  }
  return {
    ...actual,
    loadMysqlDriver: async () => {
      if (control.mysql.mode === 'fail') fail()
      return {} as never
    },
    createMysqlDialect: () => {
      if (control.mysql.mode === 'fail') fail()
      return stubDialect('mysql', false)
    },
  }
})

/** A context stand-in that records registrations and can run the plugin's disposers. */
interface FakeContext {
  readonly ctx: Context
  readonly registered: DatabaseDialect[]
  readonly disposers: (() => unknown)[]
}

/**
 * Build the smallest context `apply` needs, plus the disposer list it installed.
 * @param withEffect - when false, `effect` throws: a test proves `apply` returned before using it.
 * @returns the fake context plus the recorded state.
 */
function fakeContext(withEffect = true): FakeContext {
  const registered: DatabaseDialect[] = []
  const disposers: (() => unknown)[] = []
  const ctx = {
    dbgraph: {
      registerDialect(dialect: DatabaseDialect): () => void {
        registered.push(dialect)
        return () => {
          const index = registered.indexOf(dialect)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(execute: () => Iterable<() => unknown>): void {
      if (!withEffect) throw new Error('effect should not be used when nothing loaded')
      for (const disposer of execute()) disposers.push(disposer)
    },
  }
  return { ctx: ctx as unknown as Context, registered, disposers }
}

afterEach(() => {
  control.sqlite.mode = 'ok'
  control.sqlite.closeFails = false
  control.mysql.mode = 'ok'
  vi.restoreAllMocks()
})

describe('catalog plugin — unavailable dialects', () => {
  it('names the disabled engine and still registers the dialects that loaded', async () => {
    control.mysql.mode = 'fail'
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeContext()

    await apply(fake.ctx)

    expect(fake.registered.map(dialect => dialect.engine)).toEqual(['sqlite'])
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(
      '[dbgraph-catalog] the mysql dialect is disabled: mysql2 is not installed',
    )
  })

  it('stops without installing an effect when every dialect is unavailable', async () => {
    control.mysql.mode = 'fail'
    control.sqlite.mode = 'fail'
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    // No `effect` in this composition: reaching for it would throw, which is the assertion.
    const fake = fakeContext(false)

    await expect(apply(fake.ctx)).resolves.toBeUndefined()

    expect(fake.registered).toEqual([])
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls.map(call => call[0])).toEqual([
      '[dbgraph-catalog] the sqlite dialect is disabled: node:sqlite is unavailable',
      '[dbgraph-catalog] the mysql dialect is disabled: mysql2 is not installed',
    ])
  })

  it('reports a close failure instead of failing disposal', async () => {
    control.sqlite.closeFails = true
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeContext()
    await apply(fake.ctx)

    // Effects dispose last-in-first-out, so the registrations come back out before the handles close.
    for (const disposer of fake.disposers.reverse()) await disposer()

    expect(fake.registered).toEqual([])
    expect(report).toHaveBeenCalledWith(
      '[dbgraph-catalog] closing the sqlite dialect failed: sqlite close failed',
    )
  })
})
