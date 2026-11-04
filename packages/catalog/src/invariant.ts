/**
 * Package-owned invariant companion for `dsh-plugin-dbgraph-catalog`.
 * @module dsh-plugin-dbgraph-catalog/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-dbgraph-catalog'

/** Cordis companion plugin name. */
export const name = 'dbgraph-catalog-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no cross-plugin relation. Its dialect registrations live
 * in `ctx.dbgraph`'s private registry and its warm connection caches are private to each dialect
 * instance, torn down by the plugin's own effect-scoped disposal. There is nothing another package
 * could observe and compare against.
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
