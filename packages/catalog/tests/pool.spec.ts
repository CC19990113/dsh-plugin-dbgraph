import { describe, expect, it, vi } from 'vitest'
import { HandleCache } from '../src/pool.ts'

describe('HandleCache', () => {
  it('reuses one warm handle per connection id', async () => {
    const cache = new HandleCache<number>()
    let opened = 0
    const open = (): number => {
      opened += 1
      return opened
    }
    const close = (): void => {}

    const first = await cache.acquire('prod', 'v1', open, close)
    const second = await cache.acquire('prod', 'v1', open, close)

    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(opened).toBe(1)
    expect(cache.size).toBe(1)
  })

  it('opens one handle for two concurrent callers', async () => {
    const cache = new HandleCache<number>()
    let opened = 0
    const open = async (): Promise<number> => {
      opened += 1
      return opened
    }

    const [first, second] = await Promise.all([
      cache.acquire('prod', 'v1', open, () => {}),
      cache.acquire('prod', 'v1', open, () => {}),
    ])

    expect(first).toBe(second)
    expect(opened).toBe(1)
  })

  it('closes the previous handle when the target behind the id changes', async () => {
    const cache = new HandleCache<number>()
    let opened = 0
    const closed: number[] = []
    const open = (): number => {
      opened += 1
      return opened
    }
    const close = (handle: number): void => {
      closed.push(handle)
    }

    expect(await cache.acquire('prod', 'v1', open, close)).toBe(1)
    expect(await cache.acquire('prod', 'v2', open, close)).toBe(2)
    expect(closed).toEqual([1])
    expect(cache.size).toBe(1)
  })

  it('does not cache a failed open', async () => {
    const cache = new HandleCache<number>()
    let attempts = 0
    const open = (): number => {
      attempts += 1
      throw new Error('connection refused')
    }

    await expect(cache.acquire('prod', 'v1', open, () => {})).rejects.toThrow('connection refused')
    expect(cache.size).toBe(0)
    await expect(cache.acquire('prod', 'v1', open, () => {})).rejects.toThrow('connection refused')
    expect(attempts).toBe(2)
  })

  it('closes every handle and forgets them', async () => {
    const cache = new HandleCache<number>()
    const closed: number[] = []
    let opened = 0
    const open = (): number => {
      opened += 1
      return opened
    }
    const close = (handle: number): void => {
      closed.push(handle)
    }

    await cache.acquire('a', 'v1', open, close)
    await cache.acquire('b', 'v1', open, close)
    await cache.closeAll()

    expect(closed.sort((left, right) => left - right)).toEqual([1, 2])
    expect(cache.size).toBe(0)
  })

  it('still settles when a close fails', async () => {
    const cache = new HandleCache<number>()
    await cache.acquire('a', 'v1', () => 1, () => {
      throw new Error('close failed')
    })

    await expect(cache.closeAll()).resolves.toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('does not try to close a handle that never opened', async () => {
    let closes = 0
    const cache = new HandleCache<number>()
    const open = async (): Promise<number> => {
      throw new Error('open failed')
    }
    const close = (): void => {
      closes += 1
    }

    await expect(cache.acquire('a', 'v1', open, close)).rejects.toThrow('open failed')
    await cache.closeAll()
    expect(closes).toBe(0)
  })

  it('does not evict a newer entry when an older open for the same id fails', async () => {
    // A retry that arrives while the first open is still in flight replaces the entry. The first
    // open then fails, and its cleanup must not delete the replacement that now owns the key.
    const cache = new HandleCache<number>()
    let failFirst: (error: Error) => void = () => {}
    const failingOpen = (): Promise<number> => new Promise<number>((_, reject) => {
      failFirst = reject
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    const first = cache.acquire('prod', 'v1', failingOpen, () => {})
    await Promise.resolve()
    const replacement = cache.acquire('prod', 'v2', () => 2, () => {})
    failFirst(new Error('connection refused'))

    await expect(first).rejects.toThrow('connection refused')
    await expect(replacement).resolves.toBe(2)
    expect(cache.size).toBe(1)
    // The replaced entry's close still ran (the handle may have opened before it failed).
    expect(report).toHaveBeenCalled()
    report.mockRestore()
  })

  it('reports a non-Error close failure by string', async () => {
    const cache = new HandleCache<number>()
    await cache.acquire('a', 'v1', () => 1, () => {
      throw 'not an error'
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(cache.closeAll()).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledWith('[dbgraph-catalog] closing a cached handle failed:', 'not an error')
    report.mockRestore()
  })
})
