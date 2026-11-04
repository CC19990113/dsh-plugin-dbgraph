/**
 * Shared fixtures: a hand-written catalog with Chinese comments, foreign keys, indexes, enum samples,
 * a 300-column wide table, and a view — everything the read and resolve paths must cope with — plus
 * the temp-root helpers that keep every test away from the real `~/.dsh`.
 * @module dsh-plugin-dbgraph-store-tests/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConnectionId, ZH_ALIASES } from 'dsh-plugin-dbgraph-service'
import type {
  AliasGroup,
  IndexReport,
  RawCatalog,
  RawColumn,
  RawObject,
} from 'dsh-plugin-dbgraph-service'
import { createStore } from '../src/index.ts'
import type { Config, DbgraphIndexStore } from '../src/index.ts'
import { indexPath } from '../src/paths.ts'

/** A fresh temp directory under the system temp dir. */
export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dbgraph-store-'))
}

/** Remove a temp root. */
export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** Brand an id for `store.write`. */
export function connectionId(value: string): ReturnType<typeof ConnectionId> {
  return ConnectionId(value)
}

/** Build one column, applying overrides last. */
export function column(
  name: string,
  ordinal: number,
  type: string,
  extra: Partial<RawColumn> = {},
): RawColumn {
  return { name, ordinal, type, ...extra }
}

/** Build one table, applying overrides last. */
export function table(name: string, columns: readonly RawColumn[], extra: Partial<RawObject> = {}): RawObject {
  return { kind: 'table', name, columns, ...extra }
}

/** A 300-column table, the shape a real wide report table has. */
export function wideTable(name = 'wide_table'): RawObject {
  const columns: RawColumn[] = [column('id', 1, 'bigint', { isPrimaryKey: true })]
  for (let index = 2; index <= 300; index += 1) {
    columns.push(column(`c${String(index).padStart(3, '0')}`, index, 'varchar(32)', {
      ...(index === 2 ? { comment: '第一列' } : {}),
    }))
  }
  return table(name, columns, { comment: '宽表' })
}

/** The catalog every read-path test starts from. Engine mysql so predicate quoting is backticks. */
export const SAMPLE: RawCatalog = {
  engine: 'mysql',
  serverVersion: '8.0.36',
  database: 'shop',
  fetchedAt: 1_700_000_000_000,
  level: 'l2',
  warnings: [],
  objects: [
    table('sys_user', [
      column('id', 1, 'bigint', { isPrimaryKey: true }),
      column('user_name', 2, 'varchar(64)', { comment: '登录名', isUnique: true }),
      column('real_name', 3, 'varchar(64)', { comment: '真实姓名' }),
      column('password', 4, 'varchar(128)', { comment: '登录密码' }),
      column('phone', 5, 'varchar(20)', { comment: '手机号' }),
      column('status', 6, 'tinyint(1)', { comment: '状态', enumValues: ['1', '0'] }),
      column('dept_id', 7, 'bigint'),
      column('created_at', 8, 'datetime', { comment: '创建时间' }),
    ], {
      comment: '系统用户',
      rowEstimate: 1200,
      edges: [
        { kind: 'fk', name: 'fk_user_dept', columns: ['dept_id'], refObject: 'sys_dept', refColumns: ['id'] },
        { kind: 'index', name: 'uniq_user_name', columns: ['user_name'], unique: true },
        { kind: 'index', name: 'idx_user_phone', columns: ['phone'] },
      ],
    }),
    table('sys_dept', [
      column('id', 1, 'bigint', { isPrimaryKey: true }),
      column('dept_name', 2, 'varchar(64)', { comment: '部门名称' }),
      column('parent_id', 3, 'bigint'),
      column('updated_at', 4, 'datetime', { comment: '更新时间' }),
    ], {
      comment: '部门',
      rowEstimate: 40,
      edges: [
        { kind: 'fk', name: 'fk_dept_parent', columns: ['parent_id'], refObject: 'sys_dept', refColumns: ['id'] },
      ],
    }),
    table('orders', [
      column('id', 1, 'bigint', { isPrimaryKey: true }),
      column('user_id', 2, 'bigint'),
      column('amount', 3, 'decimal(12,2)', { comment: '订单金额' }),
      column('status', 4, 'varchar(16)', { comment: '订单状态', enumValues: ['paid', 'pending', 'cancelled'] }),
      column('created_at', 5, 'datetime', { comment: '创建时间' }),
      column('remark', 6, 'varchar(255)', { comment: '备注' }),
    ], {
      comment: '订单主表',
      rowEstimate: 90_000,
      edges: [
        { kind: 'fk', name: 'fk_orders_user', columns: ['user_id'], refObject: 'sys_user', refColumns: ['id'] },
      ],
    }),
    table('user_profile', [
      column('user_id', 1, 'bigint'),
      column('nickname', 2, 'varchar(64)', { comment: '昵称' }),
      column('avatar', 3, 'varchar(255)', { comment: '头像' }),
      column('bio', 4, 'text'),
    ], {
      comment: '用户资料',
      edges: [
        { kind: 'fk', name: 'fk_profile_user', columns: ['user_id'], refObject: 'sys_user', refColumns: ['id'] },
      ],
    }),
    table('audit_log', [
      column('id', 1, 'bigint', { isPrimaryKey: true }),
      column('user_id', 2, 'bigint'),
      column('action', 3, 'varchar(32)', { comment: '操作' }),
      column('ip', 4, 'varchar(45)', { comment: 'IP地址' }),
      column('detail', 5, 'text'),
      column('created_at', 6, 'datetime'),
    ], {
      comment: '操作日志',
      edges: [
        { kind: 'fk', name: 'fk_audit_user', columns: ['user_id'], refObject: 'sys_user', refColumns: ['id'] },
      ],
    }),
    {
      kind: 'view',
      name: 'order_summary',
      comment: '订单汇总视图',
      columns: [
        column('id', 1, 'bigint'),
        column('user_id', 2, 'bigint'),
        column('total_amount', 3, 'decimal(14,2)'),
      ],
      edges: [{ kind: 'view_ref', name: 'v_order_summary', columns: [], refObject: 'orders' }],
    },
    wideTable(),
  ],
}

/** The sample with a timestamp recent enough that freshness is not the thing under test. */
export const RECENT_SAMPLE: RawCatalog = { ...SAMPLE, fetchedAt: Date.now() }

/** A second engine's snapshot, for predicate-quoting and multi-connection tests. */
export const SQLITE_SAMPLE: RawCatalog = {
  engine: 'sqlite',
  database: '/tmp/example.db',
  fetchedAt: 1_700_000_100_000,
  level: 'l1',
  objects: [
    table('note', [
      column('id', 1, 'INTEGER', { isPrimaryKey: true }),
      column('title', 2, 'TEXT', { comment: '标题' }),
      column('status', 3, 'TEXT', { enumValues: ['draft', 'done'] }),
    ], { comment: '笔记' }),
  ],
}

/** Write one catalog with the JS path, through a store so the sidecar is exercised too. */
export async function seed(
  root: string,
  id = 'shop',
  snapshot: RawCatalog = SAMPLE,
  config: Config = {},
  aliases: readonly AliasGroup[] = ZH_ALIASES,
): Promise<{ store: DbgraphIndexStore; report: IndexReport }> {
  const store = createStore({ root, ...config })
  const report = await store.write(connectionId(id), snapshot, { writer: 'js', aliases })
  return { store, report }
}

/** Open a connection's index read-only, for row-level assertions. */
export function openRawIndex(root: string, id = 'shop'): DatabaseSync {
  return new DatabaseSync(indexPath(id, root), { readOnly: true })
}
