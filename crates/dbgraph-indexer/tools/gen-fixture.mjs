/**
 * Regenerate the Rust integration test's fixtures from the shared sources.
 *
 * Two files are written, both committed so `cargo test` needs no Node:
 *
 * - `tests/fixtures/schema-ddl.json` — `INDEX_SCHEMA_DDL` verbatim. `tools/verify-ddl.mjs` fails
 *   when this copy drifts from `packages/service/src/schema.ts`; it is a snapshot, not a second
 *   definition.
 * - `tests/fixtures/catalog.json` — one catalog that exercises every shape the writer has to get
 *   right (see `buildCatalog` below) plus the real `ZH_ALIASES` table.
 *
 * Run: `node --experimental-strip-types tools/gen-fixture.mjs`
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')

const schema = await import('../../../packages/service/src/schema.ts')
const aliases = await import('../../../packages/service/src/zh-aliases.ts')

/** The catalog the Rust tests read. Every object exists for a reason documented in the test. */
function buildCatalog() {
  const objects = [
    {
      kind: 'table',
      schema: 'shop',
      name: 'sys_user',
      comment: '系统用户',
      rowEstimate: 12,
      columns: [
        { name: 'id', ordinal: 1, type: 'bigint unsigned', nullable: false, comment: '主键', isPrimaryKey: true },
        { name: 'user_name', ordinal: 2, type: 'varchar(64)', comment: '用户名' },
        { name: 'login_pwd', ordinal: 3, type: 'varchar(128)', comment: '登录密码' },
        { name: 'phone', ordinal: 4, type: 'varchar(20)', comment: '手机号' },
        { name: 'is_deleted', ordinal: 5, type: 'tinyint(1)', comment: '是否删除', defaultValue: '0' },
        { name: 'created_at', ordinal: 6, type: 'datetime', comment: '创建时间' },
      ],
      edges: [
        { kind: 'index', name: 'uidx_phone', columns: ['phone'], unique: true },
      ],
    },
    {
      kind: 'table',
      schema: 'shop',
      name: 'order',
      comment: '订单主表',
      rowEstimate: 2048,
      columns: [
        { name: 'id', ordinal: 1, type: 'bigint', nullable: false, isPrimaryKey: true },
        { name: 'user_id', ordinal: 2, type: 'bigint', nullable: false, comment: '下单用户' },
        { name: 'order_no', ordinal: 3, type: 'varchar(32)', comment: '订单编号', isUnique: true },
        { name: 'status', ordinal: 4, type: 'varchar(16)', comment: '订单状态', enumValues: ['paid', 'pending', 'refunded'] },
        { name: 'amount', ordinal: 5, type: 'decimal(12,2)', comment: '订单金额' },
        { name: 'remark', ordinal: 6, type: 'varchar(255)', comment: '备注' },
      ],
      edges: [
        { kind: 'fk', name: 'fk_order_user', columns: ['user_id'], refObject: 'sys_user', refColumns: ['id'] },
        { kind: 'index', name: 'idx_order_status_channel', columns: ['status', 'order_no'], unique: false },
        // References a table this snapshot does not hold: the edge keeps its source side and
        // records no target, instead of guessing.
        { kind: 'fk', name: 'fk_order_region', columns: ['id'], refObject: 'region', refColumns: ['id'] },
      ],
    },
    {
      kind: 'table',
      // No schema: an engine without namespaces, and the writer stores `''`.
      name: 'order_item',
      columns: [
        { name: 'order_id', ordinal: 1, type: 'bigint', nullable: false, isPrimaryKey: true },
        { name: 'line_no', ordinal: 2, type: 'int', nullable: false, isPrimaryKey: true },
        { name: 'product_id', ordinal: 3, type: 'bigint', comment: '商品' },
        { name: 'quantity', ordinal: 4, type: 'int', comment: '购买数量' },
      ],
      edges: [
        // A composite foreign key: one edge row per column pair.
        {
          kind: 'fk',
          name: 'fk_item_order',
          columns: ['order_id', 'line_no'],
          refObject: 'shop.order',
          refColumns: ['id', 'id'],
        },
      ],
    },
    {
      kind: 'view',
      schema: 'shop',
      name: 'v_paid_order',
      comment: '已支付订单视图',
      columns: [
        { name: 'order_no', ordinal: 1, type: 'varchar(32)' },
        { name: 'amount', ordinal: 2, type: 'decimal(12,2)' },
      ],
      // An object-level relationship: a view over a table, naming no column.
      edges: [{ kind: 'view_ref', name: 'v_paid_order', columns: [], refObject: 'order' }],
    },
    {
      kind: 'table',
      // Chinese identifiers: the tokenizer's CJK path has to carry a name, not only a comment.
      schema: 'shop',
      name: '用户扩展',
      comment: '用户扩展信息',
      columns: [
        { name: '用户ID', ordinal: 1, type: 'bigint', comment: '用户主键' },
        { name: '昵称', ordinal: 2, type: 'varchar(32)', comment: '昵称' },
      ],
    },
    {
      kind: 'table',
      // Every type class, including two this build does not recognize on purpose.
      schema: 'shop',
      name: 'type_zoo',
      columns: [
        { name: 'c_int', ordinal: 1, type: 'int' },
        { name: 'c_bool', ordinal: 2, type: 'tinyint(1)' },
        { name: 'c_decimal', ordinal: 3, type: 'numeric(10,2)' },
        { name: 'c_string', ordinal: 4, type: 'varchar(32)' },
        { name: 'c_text', ordinal: 5, type: 'longtext' },
        { name: 'c_datetime', ordinal: 6, type: 'timestamp' },
        { name: 'c_json', ordinal: 7, type: 'json' },
        { name: 'c_binary', ordinal: 8, type: 'varbinary(16)' },
        { name: 'c_array', ordinal: 9, type: 'integer[]' },
        { name: 'c_custom', ordinal: 10, type: 'some_custom_type' },
        { name: 'c_empty', ordinal: 11, type: '' },
      ],
    },
    {
      kind: 'table',
      // A wide table: the store's own tests use 300 columns, so the writer is measured on one.
      schema: 'shop',
      name: 'wide_row',
      columns: Array.from({ length: 300 }, (_unused, index) => ({
        name: `col_${String(index + 1).padStart(3, '0')}`,
        ordinal: index + 1,
        type: index % 3 === 0 ? 'varchar(64)' : index % 3 === 1 ? 'bigint' : 'datetime',
        comment: index < 3 ? '宽表列' : undefined,
      })),
    },
  ]
  return {
    engine: 'mysql',
    serverVersion: '8.0.36',
    database: 'shop',
    objects,
    fetchedAt: 1_700_000_000_000,
    level: 'l2',
    warnings: ['one object could not be read'],
  }
}

mkdirSync(fixtures, { recursive: true })
writeFileSync(
  join(fixtures, 'schema-ddl.json'),
  `${JSON.stringify([...schema.INDEX_SCHEMA_DDL], null, 2)}\n`,
)
writeFileSync(
  join(fixtures, 'catalog.json'),
  `${JSON.stringify(
    {
      contract: {
        schemaVersion: schema.INDEX_SCHEMA_VERSION,
        metaKeys: schema.INDEX_META_KEYS,
      },
      catalog: buildCatalog(),
      aliases: [...aliases.ZH_ALIASES],
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${join(fixtures, 'schema-ddl.json')}`)
console.log(`wrote ${join(fixtures, 'catalog.json')}`)
