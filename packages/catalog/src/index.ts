/**
 * Catalog dialect plugin for `ctx.dbgraph`: registers one {@link DatabaseDialect} per database
 * engine so the service can reach a server, snapshot its structure, and execute the single read a
 * `find` call produces.
 *
 * **A table of dialects, not a switch.** {@link DIALECT_FACTORIES} is the whole extensibility
 * story: adding PostgreSQL, MongoDB or Redis later is one entry that loads its driver and returns a
 * `ManagedDialect`; `apply` needs no change, and the seam's "one dialect per engine" rule is
 * enforced by `ctx.dbgraph.registerDialect` itself.
 *
 * **An unavailable driver disables one dialect, never the package.** SQLite lives in Node's builtins
 * and MySQL's driver is an optional dependency, so either can be absent on a given installation. A
 * failed load logs one line naming the engine and continues; a catalog package that refused to load
 * because an unrelated driver was missing would take the working dialect down with it.
 *
 * **Disposal is ordered.** The plugin's connection caches are closed after the dialect
 * registrations are withdrawn (effects dispose last-in-first-out), so no call can be routed to a
 * dialect whose handles are already shut.
 * @module dsh-plugin-dbgraph-catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Engine } from 'dsh-plugin-dbgraph-service'
import { createMysqlDialect, loadMysqlDriver } from './mysql.ts'
import { createSqliteDialect } from './sqlite.ts'
import { messageOf } from './support.ts'
import type { ManagedDialect } from './support.ts'

export { createMysqlDialect, loadMysqlDriver, MYSQL_DRIVER_PACKAGE, mysqlIdentifier } from './mysql.ts'
export type { MysqlModule } from './mysql.ts'
export { createSqliteDialect, isStringishSqliteType, sqliteIdentifier } from './sqlite.ts'
export type { SqliteModule } from './sqlite.ts'
export { HandleCache } from './pool.ts'
export {
  DBGRAPH_QUERY_FAILED_CODE,
  DBGRAPH_READ_ONLY_CODE,
  REDACTED_VALUE,
  assertReadOnlyStatement,
  clampRowLimit,
  firstStatementKeyword,
  isReadStatement,
  messageOf,
  normalizeRows,
  renderBinary,
  throwIfAborted,
  toJsonSafe,
} from './support.ts'
export type { ManagedDialect } from './support.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'dbgraph-catalog'

/** Services required by this plugin. */
export const inject = ['dbgraph']

/** One engine's loader: resolves to a dialect, or rejects when its driver is unavailable. */
export interface DialectFactory {
  /** The engine the loaded dialect serves. */
  readonly engine: Engine
  /** Load the driver and build the dialect. */
  readonly load: () => Promise<ManagedDialect>
}

/** Why one engine's dialect could not be loaded. */
export interface DialectLoadFailure {
  /** The engine whose driver was unavailable or whose dialect failed to construct. */
  readonly engine: Engine
  /** Why it could not load, as the loader reported it. */
  readonly error: string
}

/** The outcome of trying every configured dialect. */
export interface DialectLoadResult {
  /** Dialects that loaded and should be registered. */
  readonly dialects: readonly ManagedDialect[]
  /** Engines that were skipped, one entry each. */
  readonly failures: readonly DialectLoadFailure[]
}

/**
 * Every dialect this package can provide, in registration order.
 *
 * The loaders are async because MySQL's driver is imported on demand; SQLite's builtin is imported
 * the same way so an older Node simply reports itself unavailable instead of crashing the module.
 */
export const DIALECT_FACTORIES: readonly DialectFactory[] = [
  {
    engine: 'sqlite',
    async load() {
      const module = await import('node:sqlite')
      return createSqliteDialect(module)
    },
  },
  {
    engine: 'mysql',
    async load() {
      return createMysqlDialect(await loadMysqlDriver())
    },
  },
]

/**
 * Load as many dialects as the installation supports.
 *
 * A failed loader is collected rather than thrown: one engine's missing optional driver must never
 * prevent the other engines from registering. The split from {@link apply} exists so the
 * availability decision can be tested (and reused by a deployment that mounts dialects itself)
 * without constructing a Cordis context.
 * @param factories - factories to try; defaults to {@link DIALECT_FACTORIES}.
 * @returns the dialects that loaded, plus one failure per skipped engine.
 */
export async function loadDialects(
  factories: readonly DialectFactory[] = DIALECT_FACTORIES,
): Promise<DialectLoadResult> {
  const dialects: ManagedDialect[] = []
  const failures: DialectLoadFailure[] = []
  for (const factory of factories) {
    try {
      dialects.push(await factory.load())
    } catch (error) {
      failures.push({ engine: factory.engine, error: messageOf(error) })
    }
  }
  return { dialects, failures }
}

/**
 * Register every dialect whose driver is available.
 * @param ctx - the plugin context (must inject `dbgraph`).
 * @returns a promise that settles after registration (and after every failed load was reported).
 */
export async function apply(ctx: Context): Promise<void> {
  const { dialects, failures } = await loadDialects()
  for (const failure of failures) {
    // One line per unavailable engine: enough for an operator to fix it, quiet enough that a
    // composition with SQLite only is not noisy.
    console.error(`[dbgraph-catalog] the ${failure.engine} dialect is disabled: ${failure.error}`)
  }
  if (dialects.length === 0) return

  ctx.effect(function* () {
    // Yielded first, disposed last: registrations are withdrawn before their handles close.
    yield () => closeAll(dialects)
    for (const dialect of dialects) yield ctx.dbgraph.registerDialect(dialect)
  }, 'dbgraph-catalog')
}

/**
 * Close every registered dialect's handles, reporting rather than propagating a close failure.
 * @param dialects - the dialects this plugin registered.
 */
async function closeAll(dialects: readonly ManagedDialect[]): Promise<void> {
  for (const dialect of dialects) {
    try {
      await dialect.close()
    } catch (error) {
      console.error(`[dbgraph-catalog] closing the ${dialect.engine} dialect failed: ${messageOf(error)}`)
    }
  }
}
