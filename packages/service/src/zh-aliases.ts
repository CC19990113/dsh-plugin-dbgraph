/**
 * The one place Chinese (and looser English) vocabulary is mapped onto database column meaning.
 *
 * This is a table, not a model call: no API key, no latency, and a word that is not in it simply
 * produces nothing. The same table crosses into the native index writer as JSON, so the vocabulary
 * exists exactly once — adding a group never means editing Rust.
 *
 * Two consumers:
 *
 * - the **writer**, which expands each column's name and comment into `terms` rows using these words,
 * - the **resolver**, which looks a user's word up in the same table to learn what columns it could
 *   mean (`密码` → `password`, `passwd`, `pwd`, `secret`, `credential`).
 *
 * Chosen breadth, not precision: a group with a slightly wrong word costs one extra candidate in a
 * ranked list, while a missing group costs the whole query. The resolver's confidence gate — not this
 * table — is what keeps a loose match from becoming an answer.
 * @module dsh-plugin-dbgraph-service/zh-aliases
 */

import { tokenizeForSearch } from './tokenize.ts'
import type { AliasGroup } from './types.ts'

/**
 * Words that mean the same thing, across Chinese UI vocabulary and the English it was translated
 * from. Order within `words` carries no meaning; the resolver scores by match kind, not position.
 */
export const ZH_ALIASES: readonly AliasGroup[] = [
  {
    meaning: 'user',
    words: ['用户', '用户表', '会员', '账号', '帐号', '账户', '使用者', '人员', 'user', 'users', 'member', 'account', 'customer', 'client'],
  },
  {
    meaning: 'password',
    words: ['密码', '口令', '登录密码', '登录口令', '密钥', 'password', 'passwd', 'pwd', 'secret', 'credential', 'pass'],
  },
  {
    meaning: 'name',
    words: ['姓名', '名字', '用户名', '昵称', '真实姓名', '全名', '名称', 'name', 'realname', 'real_name', 'nickname', 'nick', 'fullname', 'full_name', 'username', 'user_name'],
  },
  {
    meaning: 'phone',
    words: ['手机', '手机号', '手机号码', '电话', '电话号码', '联系方式', 'mobile', 'phone', 'phone_number', 'tel', 'telephone', 'contact'],
  },
  {
    meaning: 'email',
    words: ['邮箱', '电子邮箱', '电子邮件', '邮件', 'email', 'mail', 'e_mail'],
  },
  {
    meaning: 'idcard',
    words: ['身份证', '身份证号', '证件', '证件号', '证件号码', 'idcard', 'id_card', 'identity', 'identity_card', 'card_no'],
  },
  {
    meaning: 'gender',
    words: ['性别', 'gender', 'sex'],
  },
  {
    meaning: 'age',
    words: ['年龄', '岁数', 'age'],
  },
  {
    meaning: 'birthday',
    words: ['生日', '出生日期', '出生年月', 'birthday', 'birth', 'birth_date', 'dob'],
  },
  {
    meaning: 'address',
    words: ['地址', '住址', '收货地址', '详细地址', 'address', 'addr', 'location', 'street'],
  },
  {
    meaning: 'avatar',
    words: ['头像', '照片', '图片', 'avatar', 'photo', 'picture', 'icon', 'image', 'thumb'],
  },
  {
    meaning: 'status',
    words: ['状态', '是否', '启用', '禁用', 'status', 'state', 'flag', 'enabled', 'disabled', 'active'],
  },
  {
    meaning: 'amount',
    words: ['金额', '价格', '单价', '总价', '费用', '花费', '付款', 'amount', 'price', 'total', 'money', 'fee', 'cost', 'pay', 'payment', 'salary'],
  },
  {
    meaning: 'order',
    words: ['订单', '交易', '下单', 'order', 'orders', 'trade', 'deal', 'transaction', 'purchase'],
  },
  {
    meaning: 'product',
    words: ['商品', '产品', '货物', '货品', 'product', 'goods', 'item', 'sku', 'commodity', 'spu'],
  },
  {
    meaning: 'created',
    words: ['创建', '创建时间', '添加时间', '下单时间', 'created', 'create', 'created_at', 'createdat', 'gmt_create', 'insert', 'inserted'],
  },
  {
    meaning: 'updated',
    words: ['更新', '更新时间', '修改时间', '变更时间', 'updated', 'update', 'updated_at', 'updatedat', 'gmt_modified', 'modified', 'modify'],
  },
  {
    meaning: 'deleted',
    words: ['删除', '是否删除', '已删除', 'deleted', 'delete', 'is_delete', 'isdel', 'removed', 'trashed'],
  },
  {
    meaning: 'remark',
    words: ['备注', '说明', '描述', '详情', 'remark', 'note', 'memo', 'comment', 'description', 'desc', 'detail'],
  },
  {
    meaning: 'title',
    words: ['标题', '题目', '主题', 'title', 'subject', 'heading', 'caption'],
  },
  {
    meaning: 'code',
    words: ['编号', '编码', '代码', '序列号', 'code', 'no', 'number', 'sn', 'uuid', 'serial', 'key'],
  },
  {
    meaning: 'count',
    words: ['数量', '次数', '个数', '总量', 'count', 'num', 'qty', 'quantity', 'amount_count'],
  },
  {
    meaning: 'type',
    words: ['类型', '种类', '类别', '分类', 'type', 'category', 'kind', 'class', 'sort'],
  },
  {
    meaning: 'level',
    words: ['等级', '级别', '层级', 'level', 'grade', 'rank', 'tier', 'priority'],
  },
  {
    meaning: 'score',
    words: ['分数', '得分', '评分', 'score', 'rating', 'points', 'grade_score'],
  },
  {
    meaning: 'permission',
    words: ['权限', '角色', '职权', 'role', 'roles', 'permission', 'authority', 'admin', 'privilege'],
  },
  {
    meaning: 'department',
    words: ['部门', '组织', '单位', 'department', 'dept', 'org', 'organization', 'team', 'group', 'company'],
  },
  {
    meaning: 'ip',
    words: ['ip', 'ip地址', 'ip_addr', 'ip_address', 'client_ip', 'remote_addr'],
  },
  {
    meaning: 'device',
    words: ['设备', '机型', '设备号', 'device', 'device_id', 'imei', 'oaid', 'idfa', 'android_id'],
  },
  {
    meaning: 'login',
    words: ['登录', '登陆', '最后登录', 'login', 'logon', 'signin', 'last_login', 'lastlogin'],
  },
]

/**
 * Column-name fragments long enough to match as substrings without redacting an unrelated word. A
 * match masks the value as `[REDACTED]` and names the column in the result's `redacted` list.
 *
 * The reason this exists is not opinion: without it, one careless question puts a password hash — or
 * a password — into the transcript, and this harness persists transcripts (and indexes them).
 * `sensitiveColumns: 'show'` turns masking off for a connection that genuinely needs it.
 *
 * `secret` is deliberately absent: as a substring it redacts `secretary`, and SQL columns named
 * `secretary` are real. It lives in {@link SENSITIVE_COLUMN_TOKENS} instead, where it matches whole
 * tokens (`secret`, `secrets`, `client_secret`) and not `secretary`.
 */
export const SENSITIVE_COLUMN_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'passcode',
  'passphrase',
  'passhash',
  'salt',
  'token',
  'credential',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'apikey',
  'id_card',
  'idcard',
  'id_number',
  'bank_card',
  'bankcard',
  'cvv',
]

/**
 * Short ASCII words that are sensitive only as a whole identifier token, matched with an optional
 * trailing `s`.
 *
 * `pass` as a substring would redact `passenger` and `bypass`; as a token it covers `user_pass`,
 * `pass_hash` and `PassCode` — the spellings the alias table already treats as "password", and
 * therefore the ones a `find` can return. The trailing-`s` rule is what makes `secrets` match while
 * keeping `secretary` and `passage` out: those are different tokens, not plural forms.
 *
 * `userpass` (the concatenated spelling) is a token of its own because `pass` is not: no separator
 * splits it, and SQL columns are routinely named `userpass` by older frameworks.
 */
export const SENSITIVE_COLUMN_TOKENS: readonly string[] = ['pass', 'secret', 'userpass']

/**
 * Chinese words that mark a column as sensitive. CJK has no separators, so these match as substrings
 * of the folded name — the same rule the alias table uses for `密码` inside `登录密码`.
 */
export const SENSITIVE_CJK_WORDS: readonly string[] = ['密码', '口令', '密钥', '凭证']

/**
 * The identifier tokens of a column name, as the shared tokenizer splits them (`user_pass` gives
 * `user`, `pass`). CJK bigrams are dropped: a Chinese word is matched as a substring instead.
 * @param name - the column name.
 * @returns its ASCII tokens, lowercased.
 */
function identifierTokens(name: string): string[] {
  return tokenizeForSearch(name).filter(token => /^[a-z0-9]+$/.test(token))
}

/**
 * Whether a column name looks sensitive. Three rules, each for a different shape:
 *
 * - a Chinese word matches as a substring;
 * - a long ASCII fragment (`password`, `idcard`) matches as a substring too — a false positive on
 *   `password_reset_count` is cheaper than a missed `user_password`;
 * - a short ambiguous word (`pass`, `secret`) matches only as a whole identifier token, with an
 *   optional trailing `s`. So `passenger`, `bypass`, `compass` and `secretary` are not redacted,
 *   while `user_pass`, `pass_hash`, `client_secret` and `secrets` are. The `s` matters because a
 *   column named `secrets` is a plural of the same thing, whereas `secretary` merely shares a prefix.
 *
 * @param name - column name.
 * @param extra - additional patterns from configuration, matched with the substring rule.
 * @returns true when the column should be masked.
 */
export function isSensitiveColumn(name: string, extra: readonly string[] = []): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  if (normalized === '') return false
  for (const word of SENSITIVE_CJK_WORDS) {
    if (normalized.includes(word)) return true
  }
  for (const pattern of SENSITIVE_COLUMN_PATTERNS) {
    if (normalized.includes(pattern)) return true
  }
  const tokens = identifierTokens(name)
  for (const word of SENSITIVE_COLUMN_TOKENS) {
    if (tokens.includes(word) || tokens.includes(`${word}s`)) return true
  }
  for (const pattern of extra) {
    const needle = pattern.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    if (needle !== '' && normalized.includes(needle)) return true
  }
  return false
}
