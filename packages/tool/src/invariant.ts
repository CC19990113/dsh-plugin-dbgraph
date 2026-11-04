/**
 * Package-owned invariant companion for `dsh-plugin-dbgraph-tool`.
 * @module dsh-plugin-dbgraph-tool/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-dbgraph-tool'

/** Cordis companion plugin name. */
export const name = 'tool-dbgraph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this stateless adapter contributes two tools, one prompt section, and one
 * command, while index contents remain owned by the store seam it reads and query results remain
 * owned by the dialect seam it composes.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
