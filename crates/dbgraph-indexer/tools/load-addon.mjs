/**
 * Load the compiled napi addon for this platform.
 *
 * One file, no generated `index.js`: the artifact is named the way `napi build` names it
 * (`dbgraph-indexer.<platform>-<arch>.node`), and both the bench and the parity tool resolve it
 * here so a missing build fails with one sentence instead of a stack trace.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the addon the build script produces for this host. */
export const artifactPath = join(
  here,
  '..',
  'artifacts',
  `dbgraph-indexer.${process.platform}-${process.arch}.node`,
)

/**
 * Load the addon.
 * @returns the module's exports (`buildIndex`).
 */
export function loadAddon() {
  try {
    return require(artifactPath)
  } catch (error) {
    throw new Error(
      `cannot load the native indexer at ${artifactPath} — run \`bash build-addon.sh\` in ` +
        `crates/dbgraph-indexer first (${error.message})`,
      { cause: error },
    )
  }
}

/**
 * Load the shared contract: the schema DDL, its version, the alias table, and the tokenizer.
 *
 * Imported from the service sources rather than copied, so the bench exercises the same table
 * structure and vocabulary the store will. Requires `--experimental-strip-types`.
 * @returns the contract objects.
 */
export async function loadContract() {
  const schema = await import('../../../packages/service/src/schema.ts')
  const aliases = await import('../../../packages/service/src/zh-aliases.ts')
  return {
    schemaDdl: schema.INDEX_SCHEMA_DDL,
    schemaVersion: schema.INDEX_SCHEMA_VERSION,
    metaKeys: schema.INDEX_META_KEYS,
    aliases: aliases.ZH_ALIASES,
  }
}
