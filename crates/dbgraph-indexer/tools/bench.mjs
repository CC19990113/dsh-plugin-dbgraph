/**
 * Measure the native index kernel on a synthetic catalog, and verify the file it wrote.
 *
 * Three numbers are the point:
 *
 * 1. **How long the write takes** — the native `elapsedMs`, which is worker-thread time.
 * 2. **How long the event loop is blocked** — the synchronous part of the call, sampled
 *    independently with a 4 ms `setInterval`. This is the number the whole `AsyncTask` design exists
 *    for: `node:sqlite` would block the loop for the entire write, and a plugin that freezes the UI
 *    it runs in is not "backgrounded".
 * 3. **How the two writers compare on the same catalog** — the JavaScript writer (`node:sqlite`,
 *    synchronous) is measured by the same sampler, so the "it blocks the loop for the whole run" claim
 *    is demonstrated rather than quoted from another machine.
 * 4. **How the two transports compare** — a JS object costs a napi conversion on the loop; the same
 *    catalog as `JSON.stringify` text costs far less there and is parsed on the worker thread.
 *
 * The catalog, the DDL and the alias table all come from the real shared sources, so a change to
 * `schema.ts` or `zh-aliases.ts` is measured here rather than in a copy of them.
 *
 * Run: `node --experimental-strip-types tools/bench.mjs [objects] [runs]`
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import { loadAddon, loadContract } from './load-addon.mjs'
import { COLUMN_TEMPLATES, syntheticCatalog } from './synthetic.mjs'

/** How often the loop-delay sampler fires, in milliseconds. */
const SAMPLE_INTERVAL_MS = 4

/**
 * Run one call while sampling how long the event loop is blocked.
 *
 * The sampler is warmed up first (`armed` only flips after a tick that actually fired): the blocking
 * chunk a synchronous conversion causes lands in the *first* interval after the work starts, so
 * discarding that sample — the obvious `delays.slice(1)` — hides exactly the number being measured.
 * @param call - the call to measure. Returns `{ promise, syncMs }`, where `syncMs` is everything that
 *   ran synchronously before the promise existed.
 * @returns the call's report plus wall time and delay statistics, in milliseconds.
 */
async function whileSampling(call) {
  const delays = []
  let last = performance.now()
  let armed = false
  const timer = setInterval(() => {
    const now = performance.now()
    if (armed) delays.push(now - last - SAMPLE_INTERVAL_MS)
    last = now
    armed = true
  }, SAMPLE_INTERVAL_MS)
  timer.unref()
  const histogram = monitorEventLoopDelay({ resolution: SAMPLE_INTERVAL_MS })
  histogram.enable()
  await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS * 3))
  delays.length = 0
  const startedAt = performance.now()
  try {
    const { promise, syncMs } = call()
    const report = await promise
    return {
      report,
      syncMs,
      wallMs: performance.now() - startedAt,
      samplerMs: Math.max(0, ...delays, 0),
      histogramMs: histogram.max / 1e6,
    }
  } finally {
    histogram.disable()
    clearInterval(timer)
  }
}

/**
 * Read the written file back and prove it is a usable index.
 * @param dbPath - the index the kernel wrote.
 * @param metaKeys - the `INDEX_META_KEYS` table from the service package.
 * @param matchQueries - FTS5 expressions built by the service tokenizer from Chinese words.
 * @returns what the verification found.
 */
function verify(dbPath, metaKeys, matchQueries) {
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const count = table => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    const meta = Object.fromEntries(
      database
        .prepare('SELECT key, value FROM meta')
        .all()
        .map(row => [row.key, row.value]),
    )
    // `server_version` and `l2_indexed_at` are omitted when unknown, by contract.
    const optional = new Set(['server_version', 'l2_indexed_at'])
    const missing = Object.values(metaKeys).filter(
      key => !optional.has(key) && meta[key] === undefined,
    )
    const search = database.prepare('SELECT COUNT(*) AS n FROM search WHERE search MATCH ?')
    return {
      objects: count('objects'),
      columns: count('columns'),
      edges: count('edges'),
      terms: count('terms'),
      search: count('search'),
      meta,
      missingMetaKeys: missing,
      matches: matchQueries.map(query => ({ query, rows: search.get(query).n })),
    }
  } finally {
    database.close()
  }
}

async function main() {
  const objects = Number(process.argv[2] ?? 500)
  const runs = Number(process.argv[3] ?? 2)
  if (!Number.isInteger(objects) || objects < 1) throw new Error('objects must be a positive integer')
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer')

  const addon = loadAddon()
  const contract = await loadContract()
  const { searchMatchQuery } = await import('../../../packages/service/src/tokenize.ts')

  const generatedAt = performance.now()
  const catalog = syntheticCatalog(objects)
  const columns = catalog.objects.reduce((total, object) => total + object.columns.length, 0)
  console.log(
    `catalog: ${catalog.objects.length} objects, ${columns} columns ` +
      `(${COLUMN_TEMPLATES.length} per object), aliases ${contract.aliases.length} groups, ` +
      `built in ${(performance.now() - generatedAt).toFixed(1)} ms`,
  )

  const schemaDdl = [...contract.schemaDdl]
  const aliases = [...contract.aliases]
  const { writeIndexJs } = await import('../../../packages/store/src/writer-js.ts')
  const directory = mkdtempSync(join(tmpdir(), 'dbgraph-bench-'))
  const matchQueries = [searchMatchQuery(['订单']), searchMatchQuery(['订单金额'])]
  const summary = []
  const FIXED_NOW = 1_700_000_000_000
  try {
    for (const transport of ['js', 'object', 'json']) {
      for (let run = 1; run <= runs; run += 1) {
        const root = join(directory, `js-${run}`)
        const dbPath =
          transport === 'js'
            ? join(root, 'bench', 'index.db')
            : join(directory, `index-${transport}-${run}.db`)
        const sample = await whileSampling(() => {
          const callStartedAt = performance.now()
          let pending
          if (transport === 'js') {
            // The JavaScript writer is synchronous from end to end, so this call *is* the blocking
            // chunk the sampler sees — which is the point of comparing.
            pending = Promise.resolve(
              writeIndexJs({ connection: 'bench', catalog, aliases, root, now: FIXED_NOW }),
            )
          } else if (transport === 'json') {
            const catalogJson = JSON.stringify(catalog)
            const aliasesJson = JSON.stringify(aliases)
            pending = addon.buildIndex({
              dbPath,
              schemaDdl,
              schemaVersion: contract.schemaVersion,
              connection: 'bench',
              catalogJson,
              aliasesJson,
            })
          } else {
            pending = addon.buildIndex({
              dbPath,
              schemaDdl,
              schemaVersion: contract.schemaVersion,
              connection: 'bench',
              catalog,
              aliases,
            })
          }
          return { promise: pending, syncMs: performance.now() - callStartedAt }
        })
        const { report } = sample
        const bytes = statSync(dbPath).size
        summary.push({
          transport,
          run,
          nativeMs: report.elapsedMs,
          wallMs: sample.wallMs,
          syncMs: sample.syncMs,
          // The synchronous part *is* blocking, so it is a lower bound the samplers cannot beat — and
          // for a call that never yields (the JavaScript writer) no timer can fire during it, which is
          // why the samplers report nothing there while the loop was in fact frozen.
          blockMs: Math.max(sample.samplerMs, sample.histogramMs, sample.syncMs),
          bytes,
          dbPath,
        })
        console.log(
          [
            '',
            `${transport} transport, run ${run}: ${(bytes / 1024 / 1024).toFixed(2)} MiB index`,
            `  native write            ${report.elapsedMs.toFixed(1)} ms  ` +
              `(objects ${report.objects}, columns ${report.columns}, edges ${report.edges}, terms ${report.terms})`,
            `  wall clock              ${sample.wallMs.toFixed(1)} ms`,
            `  js thread, sync part    ${sample.syncMs.toFixed(1)} ms` +
              (transport === 'js'
                ? '  (the whole node:sqlite write)'
                : transport === 'json'
                  ? '  (JSON.stringify + dispatch)'
                  : '  (napi conversion + dispatch)'),
            `  max event-loop block    ${Math.max(sample.samplerMs, sample.histogramMs, sample.syncMs).toFixed(1)} ms ` +
              `(sampler ${sample.samplerMs.toFixed(1)} / histogram ${sample.histogramMs.toFixed(1)}` +
              `${transport === 'js' ? ' — no timer can fire inside a call that never yields' : ''})`,
          ].join('\n'),
        )
      }
    }

    const lastOf = transport => summary.filter(entry => entry.transport === transport).at(-1)
    console.log('\ntransport comparison (last run of each):')
    console.log('  transport     native      wall   js sync   max loop block   index size')
    for (const transport of ['js', 'object', 'json']) {
      const entry = lastOf(transport)
      console.log(
        `  ${transport.padEnd(10)} ${entry.nativeMs.toFixed(1).padStart(9)} ${entry.wallMs
          .toFixed(1)
          .padStart(9)} ${entry.syncMs.toFixed(1).padStart(9)} ${entry.blockMs.toFixed(1).padStart(15)} ` +
          `${(entry.bytes / 1024 / 1024).toFixed(2).padStart(10)} MiB`,
      )
    }

    const verified = verify(lastOf('json').dbPath, contract.metaKeys, matchQueries)
    console.log(
      [
        '',
        'verification of the last file (read back with node:sqlite):',
        `  rows    objects ${verified.objects}, columns ${verified.columns}, edges ${verified.edges}, ` +
          `terms ${verified.terms}, search ${verified.search}`,
        `  meta    ${Object.entries(verified.meta)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}`,
        `  missing meta keys: ${verified.missingMetaKeys.length === 0 ? 'none' : verified.missingMetaKeys.join(',')}`,
        ...verified.matches.map(match => `  FTS     ${match.query} -> ${match.rows} matching row(s)`),
      ].join('\n'),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await main()
