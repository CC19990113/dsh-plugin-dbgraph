/**
 * The one way this package renders a thrown value as text.
 *
 * It lives in its own module because five files need exactly the same rule, and a second copy is how
 * one of them ends up reporting `[object Object]` while the others report the message. `node:fs`,
 * `node:sqlite` and this package's own code only ever throw `Error`, so the last two branches are a
 * guard for whatever a native addon or a plugin hook may throw: a string, or a plain object that is
 * only meaningful once serialized.
 * @module dsh-plugin-dbgraph-store/message
 */

/**
 * Render one thrown value as a non-empty message.
 * @param error - the thrown value.
 * @returns an `Error`'s message, a thrown string as-is, or the value serialized.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error) ?? 'unknown error'
}
