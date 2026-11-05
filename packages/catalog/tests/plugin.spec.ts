import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseDialect, Engine } from 'dsh-plugin-dbgraph-service'
import { apply, DIALECT_FACTORIES, inject, loadDialects, name } from '../src/index.ts'
import type { DialectFactory } from '../src/index.ts'
import { loadMysqlDriver } from '../src/mysql.ts'
import type { ManagedDialect } from '../src/support.ts'
import * as invariant from '../src/invariant.ts'

/** A context stand-in that records registrations and can run the plugin's disposers. */
interface FakeContext {
  readonly ctx: Context
  readonly registered: DatabaseDialect[]
  readonly withdrawn: Engine[]
  dispose(): Promise<void>
}

/**
 * Build the smallest context `apply` needs: the `dbgraph` registry it writes to and the effect
 * runner it uses for disposal. Cordis itself is exercised by the service package's own tests; this
 * test is about what this plugin registers and how it tears down.
 * @returns the fake context plus the recorded state.
 */
function fakeContext(): FakeContext {
  const registered: DatabaseDialect[] = []
  const withdrawn: Engine[] = []
  const disposers: (() => unknown)[] = []

  const ctx = {
    dbgraph: {
      registerDialect(dialect: DatabaseDialect): () => void {
        registered.push(dialect)
        return () => {
          const index = registered.indexOf(dialect)
          if (index >= 0) registered.splice(index, 1)
          withdrawn.push(dialect.engine)
        }
      },
    },
    effect(execute: () => Iterable<() => unknown>): void {
      for (const disposer of execute()) disposers.push(disposer)
    },
  }

  return {
    ctx: ctx as unknown as Context,
    registered,
    withdrawn,
    async dispose() {
      // Effects dispose last-in-first-out, like the host's fiber.
      for (const disposer of disposers.reverse()) await disposer()
    },
  }
}

describe('catalog plugin', () => {
  it('is a namespace plugin that requires only the dbgraph service', () => {
    expect(name).toBe('dbgraph-catalog')
    expect(inject).toEqual(['dbgraph'])
  })

  it('declares a dialect table rather than a hard-coded switch', () => {
    expect(DIALECT_FACTORIES.map(factory => factory.engine)).toEqual(['sqlite', 'mysql'])
  })

  it('skips an unavailable engine and keeps every other dialect', async () => {
    const stub = (engine: Engine): ManagedDialect => ({
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
      close: async () => {},
    })
    const factories: DialectFactory[] = [
      { engine: 'sqlite', load: async () => stub('sqlite') },
      {
        engine: 'mysql',
        load: async () => {
          throw new Error('mysql2 is not installed')
        },
      },
    ]

    const loaded = await loadDialects(factories)

    expect(loaded.dialects.map(dialect => dialect.engine)).toEqual(['sqlite'])
    expect(loaded.failures).toEqual([{ engine: 'mysql', error: 'mysql2 is not installed' }])
  })

  it('registers SQLite always and MySQL when its driver is installed', async () => {
    const fake = fakeContext()
    await apply(fake.ctx)

    const engines = fake.registered.map(dialect => dialect.engine)
    expect(engines).toContain('sqlite')

    const mysqlAvailable = await loadMysqlDriver().then(() => true, () => false)
    if (mysqlAvailable) expect(engines).toContain('mysql')

    await fake.dispose()
    expect(fake.registered).toEqual([])
    expect(fake.withdrawn).toContain('sqlite')
  }, 30_000)
})

describe('catalog invariant companion', () => {
  it('reserves its own package name with the invariant service', async () => {
    const registered: string[] = []
    let installed = 0
    const ctx = {
      invariants: {
        register(packageName: string, install: () => void): () => void {
          registered.push(packageName)
          // The host invokes the installer; it must be a harmless no-op for this package.
          install()
          installed += 1
          return () => {}
        },
      },
    } as unknown as Context

    await invariant.apply(ctx)

    expect(invariant.name).toBe('dbgraph-catalog-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(registered).toEqual(['dsh-plugin-dbgraph-catalog'])
    expect(installed).toBe(1)
  })
})
