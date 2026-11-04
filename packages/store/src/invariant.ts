/**
 * Package-owned invariant companion for `dsh-plugin-dbgraph-store`.
 * @module dsh-plugin-dbgraph-store/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-dbgraph-store'

/** Cordis companion plugin name. */
export const name = 'dbgraph-store-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the store owns no mutable harness-visible value. Its connection pool is
 * private, and the index it reads is a file another writer replaces wholesale, so there is no owned
 * relation between two harness-visible values to compare.
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
