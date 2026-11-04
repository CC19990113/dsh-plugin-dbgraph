/**
 * One synthetic catalog, shared by the benchmark and the parity run.
 *
 * The shape is a small retail schema: user tables, order tables that reference them, Chinese comments
 * on almost every field, enum samples on every third object only (so a run mixes L1 and L2 columns),
 * composite and unique indexes, and a few views. Deterministic — the same arguments produce the same
 * catalog — because the parity check compares two writers over one input.
 */

/** Twenty columns, in declared order. `comment` absent means the server kept none. */
export const COLUMN_TEMPLATES = [
  { name: 'id', type: 'bigint', comment: '主键', isPrimaryKey: true },
  { name: 'user_id', type: 'bigint', comment: '所属用户' },
  { name: 'order_no', type: 'varchar(32)', comment: '订单编号', isUnique: true },
  { name: 'status', type: 'varchar(16)', comment: '订单状态', enum: true },
  { name: 'amount', type: 'decimal(12,2)', comment: '订单金额' },
  { name: 'paid_amount', type: 'decimal(12,2)', comment: '已付金额' },
  { name: 'quantity', type: 'int', comment: '购买数量' },
  { name: 'product_id', type: 'bigint', comment: '商品ID' },
  { name: 'remark', type: 'varchar(255)', comment: '备注' },
  { name: 'created_at', type: 'datetime', comment: '创建时间' },
  { name: 'updated_at', type: 'datetime', comment: '更新时间' },
  { name: 'is_deleted', type: 'tinyint(1)', comment: '是否删除' },
  { name: 'channel', type: 'varchar(32)', comment: '下单渠道' },
  { name: 'client_ip', type: 'varchar(45)', comment: '下单IP' },
  // One column with no comment and an unfamiliar type: the index must hold both honestly.
  { name: 'extra', type: 'json' },
  { name: 'sku', type: 'varchar(64)', comment: '商品编码' },
  { name: 'discount', type: 'decimal(10,2)', comment: '优惠金额' },
  { name: 'invoice_no', type: 'varchar(32)', comment: '发票号' },
  { name: 'shipped_at', type: 'datetime', comment: '发货时间' },
  { name: 'note', type: 'text', comment: '备注说明' },
]

/** Longest Latin token the shared tokenizer keeps whole (mirrored from `tokenize.ts`). */
const USER_OBJECT_DIVISOR = 20

/**
 * Build a deterministic synthetic catalog.
 * @param objects - how many objects to produce.
 * @param fetchedAt - epoch milliseconds recorded as the snapshot time.
 * @returns the catalog, in the seam's `RawCatalog` shape.
 */
export function syntheticCatalog(objects, fetchedAt = 1_700_000_000_000) {
  const userObjectCount = Math.min(50, Math.max(1, Math.floor(objects / USER_OBJECT_DIVISOR)))
  const list = []
  for (let index = 0; index < objects; index += 1) {
    const isUser = index < userObjectCount
    const name = isUser
      ? `sys_user_${String(index).padStart(3, '0')}`
      : `order_${String(index).padStart(4, '0')}`
    const columns = COLUMN_TEMPLATES.map((template, position) => {
      const column = {
        name: template.name,
        ordinal: position + 1,
        type: template.type,
        nullable: template.name !== 'id',
        isPrimaryKey: template.isPrimaryKey === true,
        isUnique: template.isUnique === true,
      }
      if (template.comment !== undefined) column.comment = template.comment
      if (template.enum === true && index % 3 !== 0) {
        column.enumValues = ['paid', 'pending', 'refunded', 'cancelled']
      }
      return column
    })
    const edges = []
    if (!isUser) {
      edges.push({
        kind: 'fk',
        name: `${name}_fk_user`,
        columns: ['user_id'],
        refObject: `sys_user_${String(index % userObjectCount).padStart(3, '0')}`,
        refColumns: ['id'],
      })
      edges.push({
        kind: 'index',
        name: `${name}_idx_channel_status`,
        columns: ['channel', 'status'],
        unique: false,
      })
      edges.push({
        kind: 'index',
        name: `${name}_uidx_order_no`,
        columns: ['order_no'],
        unique: true,
      })
    }
    list.push({
      kind: index % 40 === 7 ? 'view' : 'table',
      schema: 'shop',
      name,
      comment: isUser ? '系统用户' : '订单主表',
      rowEstimate: 1000 + index,
      columns,
      edges,
    })
  }
  return {
    engine: 'mysql',
    serverVersion: '8.0.36',
    database: 'shop',
    objects: list,
    fetchedAt,
    level: 'l2',
    warnings: [],
  }
}
