/**
 * Compare the native writer with the JavaScript writer, row by row.
 *
 * `packages/store/src/writer-js.ts` is the parity reference: the same catalog goes through both
 * writers with the same fixed `now`, and every row of `objects`, `columns`, `edges` and `terms` must
 * match. `search` is compared too — including its rowids, because both writers insert the documents
 * in the same order, so a difference there means one side changed what it indexes.
 *
 * Two catalogs are compared by default:
 *
 * - `tests/fixtures/catalog.json` — the semantic edge cases (composite keys, Chinese identifiers, a
 *   view reference, dangling foreign keys, a 300-column table, every type class);
 * - a synthetic 500-object / 10 000-column catalog — the size the benchmark is quoted at, where a
 *   weight or ordering divergence shows up across hundreds of thousands of term rows.
 *
 * Run: `node --experimental-strip-types tools/parity.mjs [objects]`
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { loadAddon, loadContract } from './load-addon.mjs'
import { syntheticCatalog } from './synthetic.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')

/** A fixed write timestamp, so `updated_at` and `written_at` are comparable across writers. */
const FIXED_NOW = 1_700_000_000_000

/** Which column of each table is compared, in what order. */
const TABLES = [
  { table: 'objects', order: 'id' },
  { table: 'columns', order: 'id' },
  { table: 'edges', order: 'id' },
  { table: 'terms', order: 'term, object_id, column_id' },
  { table: 'search', order: 'rowid' },
]

/**
 * Every row of one table, as one string per row.
 * @param dbPath - the index to read.
 * @param table - the table name.
 * @param order - the ORDER BY clause that makes the comparison stable.
 * @returns the rows, and the column names of the projection.
 */
function readRows(dbPath, table, order) {
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const statement = database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
    const columns = statement.columns().map(column => column.name)
    const rows = statement
      .all()
      .map(row => columns.map(name => JSON.stringify(row[name] ?? null)).join('|'))
    return { columns, rows }
  } finally {
    database.close()
  }
}

/**
 * Read the `meta` table.
 * @param dbPath - the index to read.
 * @returns key → value.
 */
function readMeta(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return Object.fromEntries(
      database
        .prepare('SELECT key, value FROM meta ORDER BY key')
        .all()
        .map(row => [row.key, row.value]),
    )
  } finally {
    database.close()
  }
}

/**
 * Compare one table between the two indexes.
 * @param label - the catalog being compared, for the report.
 * @param paths - the two index files.
 * @param spec - the table and its ordering.
 * @returns true when the rows are identical.
 */
function compareTable(label, paths, spec) {
  const js = readRows(paths.js, spec.table, spec.order)
  const rust = readRows(paths.rust, spec.table, spec.order)
  const identical =
    js.columns.join(',') === rust.columns.join(',') && js.rows.length === rust.rows.length &&
    js.rows.every((row, index) => row === rust.rows[index])

  if (identical) {
    console.log(`  ${spec.table.padEnd(9)} ${String(js.rows.length).padStart(6)} rows  identical`)
    return true
  }

  const differences = []
  const limit = Math.max(js.rows.length, rust.rows.length)
  for (let index = 0; index < limit && differences.length < 3; index += 1) {
    if (js.rows[index] !== rust.rows[index]) {
      differences.push(
        `    row ${index}:\n      js   ${js.rows[index] ?? '<missing>'}\n      rust ${rust.rows[index] ?? '<missing>'}`,
      )
    }
  }
  console.error(
    `  ${spec.table} MISMATCH (js ${js.rows.length} rows, rust ${rust.rows.length} rows)\n` +
      differences.join('\n'),
  )
  return false
}

/**
 * Compare the two writers over one catalog.
 * @param label - the catalog label for the report.
 * @param catalog - the snapshot to write twice.
 * @param aliases - the alias table.
 * @param contract - the shared DDL, version, and meta keys.
 * @param addon - the native module.
 * @param directory - the scratch directory.
 * @returns true when every table matched.
 */
async function compareCatalog(label, catalog, aliases, contract, addon, directory) {
  const connection = 'parity'
  const jsRoot = join(directory, `${label}-js`)
  const jsPath = join(jsRoot, connection, 'index.db')
  const rustPath = join(directory, `${label}-rust.db`)

  const { writeIndexJs } = await import('../../../packages/store/src/writer-js.ts')
  const jsReport = writeIndexJs({ connection, catalog, aliases, root: jsRoot, now: FIXED_NOW })
  const rustReport = await addon.buildIndex({
    dbPath: rustPath,
    schemaDdl: [...contract.schemaDdl],
    schemaVersion: contract.schemaVersion,
    connection,
    now: FIXED_NOW,
    catalogJson: JSON.stringify(catalog),
    aliasesJson: JSON.stringify(aliases),
  })

  console.log(
    `\n${label}: ${catalog.objects.length} objects, ` +
      `${catalog.objects.reduce((total, object) => total + object.columns.length, 0)} columns`,
  )
  console.log(
    `  reports: js  objects ${jsReport.objects} columns ${jsReport.columns} edges ${jsReport.edges} ` +
      `terms ${jsReport.terms}\n` +
      `           rust objects ${rustReport.objects} columns ${rustReport.columns} edges ${rustReport.edges} ` +
      `terms ${rustReport.terms}`,
  )

  const paths = { js: jsPath, rust: rustPath }
  const results = TABLES.map(spec => compareTable(label, paths, spec))

  const jsMeta = readMeta(jsPath)
  const rustMeta = readMeta(rustPath)
  const metaDifferences = Object.keys({ ...jsMeta, ...rustMeta }).filter(
    key => jsMeta[key] !== rustMeta[key],
  )
  console.log(
    `  meta      differing keys: ${metaDifferences.length === 0 ? 'none' : metaDifferences.join(', ')}` +
      '\n' +
      `            (writer ${jsMeta.writer} vs ${rustMeta.writer}; ` +
      `written_at ${jsMeta.written_at} vs ${rustMeta.written_at})`,
  )
  // `writer` is the one key that is supposed to differ: it names which implementation ran.
  const unexpectedMeta = metaDifferences.filter(key => key !== 'writer')
  if (unexpectedMeta.length > 0) {
    console.error(`  meta MISMATCH: ${unexpectedMeta.join(', ')}`)
    results.push(false)
  }

  console.log(
    `  sizes:    js ${statSync(jsPath).size} B, rust ${statSync(rustPath).size} B`,
  )
  return results.every(Boolean)
}

async function main() {
  const objects = Number(process.argv[2] ?? 500)
  if (!Number.isInteger(objects) || objects < 1) throw new Error('objects must be a positive integer')

  const addon = loadAddon()
  const contract = await loadContract()
  const fixture = JSON.parse(readFileSync(join(fixtures, 'catalog.json'), 'utf8'))
  const directory = mkdtempSync(join(tmpdir(), 'dbgraph-parity-'))

  const outcomes = []
  try {
    outcomes.push(
      await compareCatalog(
        'fixture',
        fixture.catalog,
        fixture.aliases,
        contract,
        addon,
        directory,
      ),
    )
    outcomes.push(
      await compareCatalog(
        `synthetic-${objects}`,
        syntheticCatalog(objects, FIXED_NOW),
        [...contract.aliases],
        contract,
        addon,
        directory,
      ),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  const passed = outcomes.every(Boolean)
  console.log(passed ? '\nparity: every table matched' : '\nparity: FAILED')
  if (!passed) process.exit(1)
}

await main()
