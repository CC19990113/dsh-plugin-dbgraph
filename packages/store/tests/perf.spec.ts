/**
 * The JS write path measured on the shape it will meet in production: 500 tables, 10,000 columns, real
 * alias vocabulary, Chinese comments, foreign keys and enum samples.
 *
 * This is the baseline the native writer is compared against, so it reports the numbers it measured
 * instead of asserting a wall-clock bound that would flake on a busy machine. It does assert the row
 * counts, because a fast wrong index is not a result.
 */

import { statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionId, ZH_ALIASES } from 'dsh-plugin-dbgraph-service'
import type { RawCatalog, RawColumn, RawObject } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { indexPath } from '../src/paths.ts'
import { makeRoot, openRawIndex, removeRoot } from './helpers.ts'

const roots: string[] = []
const stores: { dispose(): void }[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
})

/** Column names that hit the alias table, so the measured run includes alias expansion. */
const ALIASED_NAMES = ['user_id', 'user_name', 'password', 'phone', 'status', 'amount', 'created_at']

/**
 * One column's name, so the edge definition below can point at the column the loop actually creates.
 * @param columnIndex - one-based column ordinal.
 * @returns the generated name.
 */
function aliasedName(columnIndex: number): string {
  return `${ALIASED_NAMES[columnIndex % ALIASED_NAMES.length] as string}_${columnIndex}`
}

/**
 * Build the synthetic catalog: 500 tables of 20 columns each.
 * @param tableCount - how many tables.
 * @param columnsPerTable - how many columns per table.
 * @returns the snapshot.
 */
function syntheticCatalog(tableCount = 500, columnsPerTable = 20): RawCatalog {
  const objects: RawObject[] = []
  for (let index = 0; index < tableCount; index += 1) {
    const columns: RawColumn[] = [{
      name: 'id',
      ordinal: 1,
      type: 'bigint',
      isPrimaryKey: true,
    }]
    for (let columnIndex = 2; columnIndex <= columnsPerTable; columnIndex += 1) {
      const name = aliasedName(columnIndex)
      columns.push({
        name,
        ordinal: columnIndex,
        type: columnIndex % 5 === 0 ? 'varchar(64)' : columnIndex % 3 === 0 ? 'decimal(12,2)' : 'bigint',
        ...(columnIndex % 4 === 0
          ? { comment: `第${columnIndex}个字段`, enumValues: ['a', 'b', 'c'] }
          : { comment: `column ${columnIndex}` }),
        ...(columnIndex === 2 ? { isUnique: true } : {}),
      })
    }
    const referenced = objects[0]
    objects.push({
      kind: 'table',
      name: `t_${String(index).padStart(3, '0')}`,
      ...(index % 2 === 0 ? { comment: `业务表${index}` } : {}),
      rowEstimate: index * 100,
      columns,
      ...(index > 0 && index % 5 === 0 && referenced !== undefined
        ? { edges: [{ kind: 'fk', name: `fk_t_${index}`, columns: [aliasedName(2)], refObject: referenced.name, refColumns: ['id'] }] }
        : {}),
    })
  }
  return {
    engine: 'mysql',
    serverVersion: '8.0.36',
    database: 'perf',
    fetchedAt: 1_700_000_000_000,
    level: 'l2',
    objects,
  }
}

describe('js writer throughput', () => {
  it('writes a 500-table / 10,000-column catalog and reports the measured cost', async () => {
    const root = makeRoot()
    roots.push(root)
    const catalog = syntheticCatalog()
    const store = createStore({ root })
    stores.push(store)

    const started = performance.now()
    const report = await store.write(ConnectionId('perf'), catalog, {
      writer: 'js',
      aliases: ZH_ALIASES,
    })
    const wall = performance.now() - started

    const db = openRawIndex(root, 'perf')
    try {
      const objects = (db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count
      const columns = (db.prepare('SELECT COUNT(*) AS count FROM columns').get() as { count: number }).count
      const edges = (db.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number }).count
      const terms = (db.prepare('SELECT COUNT(*) AS count FROM terms').get() as { count: number }).count
      const search = (db.prepare('SELECT COUNT(*) AS count FROM search').get() as { count: number }).count
      const bytes = statSync(indexPath('perf', root)).size

      expect(report.objects).toBe(500)
      expect(report.columns).toBe(10_000)
      expect(report.writer).toBe('js')
      expect(objects).toBe(500)
      expect(columns).toBe(10_000)
      expect(edges).toBe(99)
      expect(terms).toBeGreaterThan(10_000)
      expect(search).toBe(10_500)

      // The measured baseline. Kept as a log line (and in the run's report to the lead), not as a
      // timing assertion: a shared CI box makes any hard bound a flake generator.
      console.log(
        `[dbgraph-store][js-writer] 500 tables / 10000 columns: report.elapsedMs=${report.elapsedMs}`
        + ` wall=${Math.round(wall)}ms objects=${objects} columns=${columns} edges=${edges}`
        + ` terms=${terms} search=${search} bytes=${bytes} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
      )
      expect(report.elapsedMs).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  }, 180_000)
})
