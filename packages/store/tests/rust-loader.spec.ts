/**
 * The native-kernel *loader*, exercised against stand-ins rather than the real artifact.
 *
 * `rust-writer.spec.ts` measures the real addon when this machine has one; this file owns the paths a
 * checkout without a built addon still has to get right — an override pointing somewhere, an artifact
 * that loads but exports the wrong thing, one that throws, one whose answer is unusable, and the
 * platform suffix probe. `DSH_DBGRAPH_RUST_ADDON` is the documented test hook, so pointing it at a
 * hand-written CommonJS module is using the contract, not bypassing it.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INDEX_META_KEYS } from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import { indexPath } from '../src/paths.ts'
import { ADDON_ENV, loadRustIndexer, resolveAddonPath, serializePayload } from '../src/rust-engine.ts'
import { SAMPLE, connectionId, makeRoot, openRawIndex, removeRoot } from './helpers.ts'

const originalAddon = process.env[ADDON_ENV]
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
const roots: string[] = []
const stores: { dispose(): void }[] = []
const scratch: string[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const root of roots.splice(0)) removeRoot(root)
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalAddon === undefined) delete process.env[ADDON_ENV]
  else process.env[ADDON_ENV] = originalAddon
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  if (originalArch) Object.defineProperty(process, 'arch', originalArch)
})

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

/** Write one CommonJS stand-in artifact and return its path. */
function fakeAddon(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbgraph-addon-'))
  scratch.push(dir)
  const file = join(dir, 'addon.cjs')
  writeFileSync(file, source, 'utf8')
  return file
}

/** A stand-in that writes the real schema and one object, then reports what it wrote. */
function workingAddon(report = '{ objects: 1, columns: 1, edges: 0, terms: 0, elapsedMs: 2 }'): string {
  return fakeAddon(`
const { DatabaseSync } = require('node:sqlite')
module.exports = {
  async buildIndex(input) {
    const db = new DatabaseSync(input.dbPath)
    for (const statement of input.schemaDdl) db.exec(statement)
    const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    meta.run('schema_version', String(input.schemaVersion))
    meta.run('connection', input.connection)
    meta.run('engine', 'mysql')
    meta.run('database', 'shop')
    meta.run('level', 'l1')
    meta.run('writer', 'rust')
    meta.run('written_at', String(input.now))
    db.prepare(
      'INSERT INTO objects (id, kind, schema_name, name, comment, row_estimate, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'table', '', 'fake_table', null, null, input.now)
    db.prepare(
      \`INSERT INTO columns (id, object_id, ordinal, name, type, type_class, nullable, default_value,
         comment, is_primary_key, is_unique, enum_values_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
    ).run(1, 1, 1, 'id', 'bigint', 'integer', 0, null, null, 1, 0, null, input.now)
    db.close()
    return ${report}
  },
}
`)
}

describe('resolveAddonPath', () => {
  it('prefers an override that exists', () => {
    const path = fakeAddon('module.exports = {}')
    process.env[ADDON_ENV] = path
    expect(resolveAddonPath()).toEqual({ path, reason: `loaded from ${ADDON_ENV}` })
  })

  it('explains an override that does not exist instead of falling back silently', () => {
    const missing = join(tmpdir(), 'dbgraph-no-such-addon', 'dbgraph-indexer.node')
    process.env[ADDON_ENV] = missing
    const resolution = resolveAddonPath()
    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain(missing)
  })

  it('probes the Linux qualifier suffixes when the host is Linux', () => {
    delete process.env[ADDON_ENV]
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'noarch', configurable: true })
    const resolution = resolveAddonPath()
    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain('linux-noarch-gnu')
    expect(resolution.reason).toContain('linux-noarch-musl')
  })

  it('probes the MSVC suffix when the host is Windows', () => {
    delete process.env[ADDON_ENV]
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'noarch', configurable: true })
    const resolution = resolveAddonPath()
    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain('win32-noarch-msvc')
  })

  it('reports every candidate it looked for when none exists', () => {
    delete process.env[ADDON_ENV]
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'noarch', configurable: true })
    const resolution = resolveAddonPath()
    expect(resolution.path).toBeUndefined()
    expect(resolution.reason).toContain('no native artifact for sunos-noarch')
  })
})

describe('loadRustIndexer', () => {
  it('loads a module that exports buildIndex', () => {
    process.env[ADDON_ENV] = workingAddon()
    const loaded = loadRustIndexer()
    expect(loaded.engine).toBeDefined()
    expect(loaded.reason).toContain('loaded')
    // A second call reuses the cached load for the same path.
    expect(loadRustIndexer()).toBe(loaded)
  })

  it('refuses a module that exports no buildIndex function', () => {
    process.env[ADDON_ENV] = fakeAddon('module.exports = () => {}')
    const loaded = loadRustIndexer()
    expect(loaded.engine).toBeUndefined()
    expect(loaded.reason).toContain('exports no buildIndex function')
  })

  it('refuses a module that exports a non-function buildIndex', () => {
    process.env[ADDON_ENV] = fakeAddon('module.exports = { buildIndex: 42 }')
    const loaded = loadRustIndexer()
    expect(loaded.engine).toBeUndefined()
    expect(loaded.reason).toContain('exports no buildIndex function')
  })

  it('reports a module that fails to load, with its message', () => {
    process.env[ADDON_ENV] = fakeAddon("throw new Error('not a native addon')")
    const loaded = loadRustIndexer()
    expect(loaded.engine).toBeUndefined()
    expect(loaded.reason).toContain('failed to load')
    expect(loaded.reason).toContain('not a native addon')
  })

  it('reports a module that fails to load with a non-Error value', () => {
    process.env[ADDON_ENV] = fakeAddon("throw 'load refused'")
    const loaded = loadRustIndexer()
    expect(loaded.engine).toBeUndefined()
    expect(loaded.reason).toContain('load refused')
  })
})

describe('serializePayload', () => {
  it('sends the catalog and the alias table as JSON text', () => {
    const aliases = [{ meaning: 'user', words: ['user', '用户'] }]
    const payload = serializePayload({ catalog: SAMPLE, aliases })
    expect(JSON.parse(payload.catalogJson)).toEqual(SAMPLE)
    expect(JSON.parse(payload.aliasesJson)).toEqual(aliases)
  })
})

describe('the store with a native kernel loaded', () => {
  it('renames a native build into place and reports its own counts', async () => {
    process.env[ADDON_ENV] = workingAddon()
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'rust', aliases: [] })
    expect(report).toMatchObject({ writer: 'rust', objects: 1, columns: 1, edges: 0, terms: 0 })
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(report.warnings).toEqual([])
    // The file the addon wrote is the live index, and the reader serves it.
    await expect(store.state('shop')).resolves.toMatchObject({ objects: 1, columns: 1, writer: 'rust' })
    const db = openRawIndex(root)
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('selects the native kernel for an automatic write', async () => {
    process.env[ADDON_ENV] = workingAddon()
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })
    expect(report).toMatchObject({ writer: 'rust', objects: 1, columns: 1 })
  })

  it('degrades an automatic write to the JavaScript path when the native call rejects', async () => {
    process.env[ADDON_ENV] = fakeAddon(`
module.exports = {
  async buildIndex() { throw new Error('native build failed') },
}
`)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const root = freshRoot()
      const store = createStore({ root })
      stores.push(store)
      const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })
      expect(report.writer).toBe('js')
      expect(report.objects).toBe(SAMPLE.objects.length)
      expect(String(errors.mock.calls[0]?.[0])).toContain('native index writer is unavailable')
    } finally {
      errors.mockRestore()
    }
  })

  it('reports an empty warning list for a catalog that carries none', async () => {
    process.env[ADDON_ENV] = workingAddon()
    const { warnings: _warnings, ...bare } = SAMPLE
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), bare, { writer: 'rust', aliases: [] })
    expect(report.warnings).toEqual([])
  })

  it('degrades an automatic write when the native report is unusable', async () => {
    process.env[ADDON_ENV] = workingAddon('{ objects: 1 }')
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    const report = await store.write(connectionId('shop'), SAMPLE, { writer: 'auto', aliases: [] })
    expect(report.writer).toBe('js')
    expect(report.objects).toBe(SAMPLE.objects.length)
  })

  it('refuses a native report that could not have come from a real write', async () => {
    process.env[ADDON_ENV] = workingAddon('{ objects: 1 }')
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await expect(
      store.write(connectionId('shop'), SAMPLE, { writer: 'rust', aliases: [] }),
    ).rejects.toMatchObject({ code: 'DBGRAPH_WRITE_FAILED', message: expect.stringContaining('unusable report') })
    // No partial answer reaches the live index, and the staging file is gone.
    expect(existsSync(indexPath('shop', root))).toBe(false)
    expect(readdirSync(join(root, 'shop')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('reports a failed rename without leaving the staging file behind', async () => {
    process.env[ADDON_ENV] = workingAddon()
    const root = freshRoot()
    // A directory where the live index belongs makes the final rename impossible.
    mkdirSync(indexPath('shop', root), { recursive: true })
    const store = createStore({ root })
    stores.push(store)
    await expect(
      store.write(connectionId('shop'), SAMPLE, { writer: 'rust', aliases: [] }),
    ).rejects.toMatchObject({ code: 'DBGRAPH_WRITE_FAILED', message: expect.stringContaining('renaming') })
    // The connection directory holds only the placeholder that made the rename fail.
    const left = readdirSync(join(root, 'shop'))
    expect(left.filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails an explicit rust request when the native call rejects', async () => {
    process.env[ADDON_ENV] = fakeAddon(`
module.exports = {
  async buildIndex() { throw new Error('native build failed') },
}
`)
    const root = freshRoot()
    const store = createStore({ root })
    stores.push(store)
    await expect(
      store.write(connectionId('shop'), SAMPLE, { writer: 'rust', aliases: [] }),
    ).rejects.toMatchObject({ code: 'DBGRAPH_WRITE_FAILED', message: expect.stringContaining('native build failed') })
  })
})
