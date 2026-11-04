/**
 * Fail when the test fixtures have drifted from the shared sources.
 *
 * `tests/fixtures/schema-ddl.json` and the `aliases` half of `tests/fixtures/catalog.json` are
 * snapshots of `packages/service`, taken so `cargo test` needs no Node. A snapshot that silently
 * drifts is worse than no snapshot: the Rust tests would pass against a schema nobody uses. This
 * script is the guard — run it before trusting a green `cargo test`.
 *
 * Run: `node --experimental-strip-types tools/verify-ddl.mjs`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')

const schema = await import('../../../packages/service/src/schema.ts')
const aliases = await import('../../../packages/service/src/zh-aliases.ts')

const storedDdl = JSON.parse(readFileSync(join(fixtures, 'schema-ddl.json'), 'utf8'))
const storedCatalog = JSON.parse(readFileSync(join(fixtures, 'catalog.json'), 'utf8'))

const problems = []
const compare = (label, expected, actual) => {
  const left = JSON.stringify(expected)
  const right = JSON.stringify(actual)
  if (left !== right) problems.push(`${label}: fixture and source differ`)
}

compare('INDEX_SCHEMA_DDL', [...schema.INDEX_SCHEMA_DDL], storedDdl)
compare('zh-aliases ZH_ALIASES', [...aliases.ZH_ALIASES], storedCatalog.aliases)

if (storedCatalog.contract.schemaVersion !== schema.INDEX_SCHEMA_VERSION) {
  problems.push(
    `INDEX_SCHEMA_VERSION: fixture ${storedCatalog.contract.schemaVersion}, source ${schema.INDEX_SCHEMA_VERSION}`,
  )
}

if (problems.length > 0) {
  console.error('fixtures are stale — run `node --experimental-strip-types tools/gen-fixture.mjs`:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `fixtures match the sources: ${storedDdl.length} DDL statements, ` +
    `${storedCatalog.aliases.length} alias groups, schema version ${schema.INDEX_SCHEMA_VERSION}`,
)
