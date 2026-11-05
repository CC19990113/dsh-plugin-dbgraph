import { describe, expect, it, vi } from 'vitest'

/**
 * The optional driver is imported on demand, so a deployment without `mysql2` must get a named
 * error — not a package that fails to load. This file is the only place that can force the import
 * to fail: the module registry is mocked before `mysql.ts` resolves it.
 */
vi.mock('mysql2/promise', () => {
  throw new Error('Cannot find package mysql2')
})

/** Imported after the mock registration; the import itself stays dynamic inside the loader. */
const { loadMysqlDriver } = await import('../src/mysql.ts')

describe('loadMysqlDriver', () => {
  it('names the missing driver and clears the failed load so a retry can succeed later', async () => {
    await expect(loadMysqlDriver()).rejects.toMatchObject({
      code: 'DBGRAPH_DRIVER_MISSING',
      message: expect.stringContaining('mysql2 is required by the mysql dialect'),
    })

    // `driverPromise` is cleared on failure; a second call therefore attempts the import again
    // instead of replaying the rejected promise forever.
    await expect(loadMysqlDriver()).rejects.toMatchObject({ code: 'DBGRAPH_DRIVER_MISSING' })
  })
})
