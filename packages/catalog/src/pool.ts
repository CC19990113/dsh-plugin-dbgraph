/**
 * One warm handle per connection id.
 *
 * A dialect is asked for the same connection repeatedly inside one indexing run — L1, then L2, then
 * possibly a `find` execution — and reconnecting for each phase would pay a handshake per query on
 * MySQL and reopen a file per PRAGMA batch on SQLite. This cache keeps the handle alive for the
 * plugin's lifetime instead, which is also why every dialect exposes `close()` and the plugin calls
 * it on disposal.
 *
 * State is keyed by **connection id**, exactly as configured. The fingerprint beside it guards a
 * configuration change: if the host/port/database behind the same id changes, the old handle is
 * closed before a new one is opened, so a renamed target never silently serves the previous
 * database.
 *
 * The cached password situation is deliberate: a pool necessarily holds authenticated connections,
 * but this module never stores the plaintext password itself and never passes it to `open` a second
 * time for an existing entry — the caller's per-operation password is only consulted when a handle
 * is actually created.
 * @module dsh-plugin-dbgraph-catalog/pool
 */

/** What the cache remembers about one warm handle. */
interface CachedHandle<T> {
  /** Target identity the handle was opened for. */
  readonly fingerprint: string
  /** The in-flight or settled open; shared by concurrent callers. */
  readonly ready: Promise<T>
  /** Closes a handle that did open. */
  readonly close: (handle: T) => Promise<void> | void
}

/** A handle cache keyed by connection id. */
export class HandleCache<T> {
  private readonly entries = new Map<string, CachedHandle<T>>()

  /** Number of live handles; exposed so a test can prove reuse rather than infer it from timing. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Return the cached handle for one connection, opening it when absent or when the target changed.
   * Concurrent callers for the same key share one open, so two statements cannot race into two
   * pools.
   * @param key - the connection id.
   * @param fingerprint - target identity; a change closes the previous handle first.
   * @param open - creates the handle; may be synchronous.
   * @param close - closes the handle; called on replacement and on {@link closeAll}.
   * @returns the warm handle.
   */
  async acquire(
    key: string,
    fingerprint: string,
    open: () => T | Promise<T>,
    close: (handle: T) => Promise<void> | void,
  ): Promise<T> {
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.ready
      this.entries.delete(key)
      await settleClose(existing)
    }

    const entry: CachedHandle<T> = {
      fingerprint,
      close,
      ready: Promise.resolve().then(open),
    }
    this.entries.set(key, entry)
    try {
      return await entry.ready
    } catch (error) {
      // A failed open must not leave a permanently rejected entry behind: the next call should be
      // able to retry (the server may simply have been starting up).
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  /**
   * Close every cached handle. Entries are removed before closing, so a close that fails cannot
   * leave a handle this cache still believes it owns.
   * @returns a promise that settles after every close was attempted.
   */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) await settleClose(entry)
  }
}

/**
 * Close one entry, tolerating both a handle that never finished opening and a failing close — a
 * shutdown path must not throw because the thing it is shutting down already failed.
 * @param entry - the cached entry to close.
 */
async function settleClose<T>(entry: CachedHandle<T>): Promise<void> {
  try {
    await entry.close(await entry.ready)
  } catch {
    // Nothing left to release, or the release itself failed; either way disposal continues.
  }
}
