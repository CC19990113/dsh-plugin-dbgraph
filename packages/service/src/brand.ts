/**
 * dbgraph's owned branded ids. {@link ConnectionId} names one configured database connection; it is
 * the key everything else is scoped by (index directory, credential reference, status entry).
 * @module dsh-plugin-dbgraph-service/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one configured connection. Chosen by the user (`prod`, `test-qingpei`), used
 * verbatim as a directory name under the index root, so the registry validates it against a
 * restricted alphabet before minting one.
 */
export type ConnectionId = Branded<'ConnectionId'>

/**
 * Brand a string as a {@link ConnectionId}. No validation — the caller that reads user configuration
 * is what rejects an unusable id (see `isValidConnectionId`).
 * @param id - the connection's stable identifier.
 * @returns the same string, branded.
 */
export function ConnectionId(id: string): ConnectionId {
  return id as ConnectionId
}

/**
 * Whether a raw string may become a {@link ConnectionId}. Restricted to what is safe as both a
 * directory name and a POSIX-environment-variable fragment, because the credential reference is
 * derived from it: lowercase letters, digits, `-` and `_`, starting with a letter or digit.
 * @param id - candidate identifier.
 * @returns true when the id is usable as a connection identity.
 */
export function isValidConnectionId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

/**
 * The credential reference a connection's password lives under. The host's credential seam carries
 * POSIX environment-variable names, so this is the derivation every caller must share: consume it
 * through {@link credentialRefName} rather than rebuilding the string.
 * @param id - the connection identity.
 * @returns the environment-variable-style reference name, e.g. `DBGRAPH_PROD_PASSWORD`.
 */
export function credentialRefName(id: ConnectionId): string {
  return `DBGRAPH_${id.toUpperCase().replace(/-/g, '_')}_PASSWORD`
}
