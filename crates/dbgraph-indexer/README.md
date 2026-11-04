# dbgraph-indexer — the native index write kernel

A napi addon that turns one raw database catalog into one SQLite index file: normalization, the term
vocabulary, the alias expansion, and the whole insert, inside a single transaction.

The reason it exists is a measurement, not an opinion. `node:sqlite` is synchronous, so the JavaScript
writer blocks the host's event loop for the **entire** write — on the catalog below, ~2 seconds. The
native kernel runs the same work on libuv's thread pool and blocks the loop for the time it takes to
hand over the input: **11–34 ms**, depending on which transport the caller uses.

`packages/store/src/writer-js.ts` remains the parity reference and the fallback. This kernel is
measured against it: `tools/parity.mjs` runs both writers over the same catalog and compares
`objects`, `columns`, `edges`, `terms` and `search` row by row.

## Contract

```ts
declare function buildIndex(input: BuildIndexInput): Promise<BuildReport>

interface BuildIndexInput {
  dbPath: string            // the `.tmp` file to write; the caller renames it into place
  schemaDdl: string[]       // INDEX_SCHEMA_DDL, executed verbatim
  schemaVersion: number     // INDEX_SCHEMA_VERSION → meta.schema_version
  connection?: string       // → meta.connection
  now?: number              // epoch ms to stamp; omitted means the current time
  catalog?: RawCatalog      // the catalog as a JS object
  aliases?: AliasGroup[]    // as a JS object
  catalogJson?: string      // JSON.stringify(catalog) — preferred, see transports
  aliasesJson?: string      // JSON.stringify(aliases)
}

interface BuildReport {
  objects: number
  columns: number
  edges: number
  terms: number
  elapsedMs: number
}
```

- **`AsyncTask` is the point**, not a detail: `Task::compute` runs on libuv's thread pool and the JS
  thread receives a promise. A synchronous `#[napi]` function would freeze the host for the whole
  write, which is exactly what this crate exists to avoid.
- **Two transports for the same payload.** Either the object form (`catalog`/`aliases`) or the text
  form (`catalogJson`/`aliasesJson`); a non-empty `…Json` wins. They produce byte-identical data, and
  the measured difference is on the JS thread: converting a JS object to `serde_json::Value` through
  napi costs ~30 ms per 10 000 columns, while `JSON.stringify` costs ~5 ms and the parse then happens
  on the worker thread. A caller that cares about loop latency should stringify.
- **`now`** makes a run reproducible (a test, or the parity comparison). Omitted, the kernel stamps
  the current time once and uses it for `objects.updated_at`, `columns.updated_at` and
  `meta.written_at`, so those three can never disagree.
- **Failures reject.** Input is parsed with serde and every validation failure names the field that
  carries it (`catalog.objects[3].columns[0].ordinal must be a positive one-based position, received 0`).
  A panic is caught (`panic = "unwind"` + `catch_unwind`) and becomes a rejected promise; the process
  is never aborted. On any error the partial file is deleted — a caller may assume the path is either
  a complete index or absent.
- **No I/O beyond the index file**, no network, no environment reads. The rename into place and the
  `status.json` sidecar belong to the caller.

## Build

```sh
cd crates/dbgraph-indexer
bash build-addon.sh
# => artifacts/dbgraph-indexer.<platform>-<arch>.node
```

Two host facts the script exists for, both verified on this machine:

1. **The default rust toolchain is `stable-x86_64-apple-darwin` while Node is arm64.** A plain
   `cargo build --release` therefore produces an x64 library that arm64 Node refuses to load
   (`incompatible architecture`). The script picks the toolchain whose host matches Node's arch.
2. **`--target <triple>`** keeps each triple's output in `target/<triple>/release/`, so alternating
   between the two native toolchains cannot thrash one shared `target/release/`.

`@napi-rs/cli` is not required. With network access, `pnpm run build:napi` runs `napi build
--platform --release` instead and additionally emits `index.js`/`index.d.ts`.

## Test and verify

```sh
bash test-addon.sh                                    # 41 tests: 28 unit + 13 integration
node --experimental-strip-types tools/parity.mjs 500  # both writers, five tables, row by row
node --experimental-strip-types tools/bench.mjs 500 2 # write time, loop block, index size
node --experimental-strip-types tools/verify-ddl.mjs  # fixtures still match packages/service
node --experimental-strip-types tools/gen-fixture.mjs # regenerate the fixtures
```

- `tests/fixtures/catalog.json` and `schema-ddl.json` are **snapshots** of the shared contract, taken
  so `cargo test` needs no Node. `tools/verify-ddl.mjs` fails when they drift; the fixture generator
  reads `INDEX_SCHEMA_DDL`, `INDEX_SCHEMA_VERSION` and `ZH_ALIASES` from `packages/service` directly.
  No table structure and no vocabulary is written twice.
- `tests/tokenizer_parity.rs` reads `packages/store/tests/fixtures/tokens.json` — the corpus the store
  asserts against the TypeScript tokenizer — so the two implementations are held to one file.
- The integration tests build over the fixture and read the file back row by row: type classes, ids,
  cleaned comments, enum samples, a 300-column table, composite foreign keys paired by position, a
  dropped dangling edge, an object-level `view_ref`, the meta keys, and an FTS5 match on a Chinese
  bigram. They also prove two properties that are easy to lose: the same catalog writes the same rows
  twice, and both transports produce identical files.

## What normalization decides

**One tokenizer, shared.** `terms::tokenize_for_search` is a port of `tokenizeForSearch` in
`packages/service/src/tokenize.ts`, and *every* term and every `search.text` document is its output —
never a raw word. ASCII runs split on camel-case and letter/digit boundaries (`createdAt` → `created
at`, `HTMLParser` → `html parser`, `v2` → `v 2`); CJK runs split into overlapping bigrams (`广告点击` →
`广告 告点 点击`); NFKC first; deduplicated in first-seen order. The reason the text is pre-tokenized
at all: FTS5's `unicode61` treats a run of Chinese as one token, so indexing `广告点击` verbatim and
searching for `广告` returns nothing (verified on SQLite 3.50.4).

**Term weights** — `TERM_WEIGHTS` in `packages/store/src/terms.ts`, mirrored exactly:

| source | ASCII token | CJK bigram |
|---|---|---|
| object name | 1.00 | 0.75 |
| object comment | 0.75 | 0.50 |
| object alias expansion | 0.60 | 0.60 |
| column name | 0.90 | 0.75 |
| column comment | 0.70 | 0.50 |
| column alias expansion | 0.65 | 0.65 |

A duplicate `(term, object_id, column_id)` keeps the highest weight. Rows are ordered by term before
insertion, which the reference writer does not do — terms carry no identity column, so the two orders
hold the same rows (and `tools/parity.mjs` compares them sorted).

**Alias matching** is the reference's three-shape rule, not a substring rule: a single ASCII word must
be an exact token (`user` matches `sys_user`, but `no` does not match `notification` and `order` does
not match `border_id`); a CJK word matches as a substring (`用户` in `系统用户`), because Chinese has no
separators; a multi-token word matches its folded form (`real_name` ↔ `realname`). When a group
matches, **every** word of it enters the terms plus its canonical meaning, all at the alias weight.

**Type classes** are a port of `typeClassOf`: nine families plus `unknown`, in the reference's order —
`tinyint(1)` and `bit` answer `bool` before the integer or binary families see them, `year` answers
`datetime`, `geometry` answers `unknown`. Anything unrecognized is `unknown` rather than a guess,
because a wrong class makes a numeric filter look safe when it is not.

**Comments** are NFKC-normalized, control characters folded to spaces, whitespace runs collapsed,
trimmed, and capped at 2 000 UTF-16 code units.

**Identity** is assigned deterministically: `objects.id` is the catalog position plus one, `columns.id`
is a global running number in catalog order. Both writers must agree or no row comparison is possible.

**Edges** follow the reference: one row per column of the edge, paired by position with `refColumns`;
an edge whose `refObject` is not in the snapshot is dropped rather than written with a NULL target; a
source column that does not exist drops that row. A primary-key column is recorded as `NOT NULL` even
if the catalog claimed otherwise. `RawEdge.unique` is dropped — the shared `edges` table has no column
for it, which is a format limit, not an omission.

## Measured

500 objects / 10 000 columns (the synthetic catalog in `tools/synthetic.mjs`: Chinese comments, 1 900
edges, 157 675 term rows, 10 500 search rows), same catalog and same machine for all three rows.
Node v22.21.0, macOS arm64, rustc 1.96.0 (`aarch64-apple-darwin`), release build, `tools/bench.mjs 500 2`:

| writer | write (native) | JS-thread sync part | max event-loop block | index file |
|---|---|---|---|---|
| `writer-js.ts` (`node:sqlite`) | 1992.0 ms | 1992.2 ms | **1992.2 ms** | 8.46 MiB |
| native, object transport | 218.2 ms | 30.2 ms | **33.6 ms** | 8.41 MiB |
| native, JSON-text transport | 252.4 ms | 5.2 ms | **11.1 ms** | 8.41 MiB |

Run-to-run over two runs each: JS writer 1988–1992 ms; native object transport 216–221 ms; native JSON
transport 225–252 ms. The native JSON path is *slower natively* by ~25 ms — parsing the 2 MB document on
the worker thread — and ~6× cheaper on the event loop, which is the trade a UI cares about.

Twice the size (`tools/bench.mjs 1000 2` — 1 000 objects / 20 000 columns, 16.9 MiB index):

| writer | write (native) | JS-thread sync part | max event-loop block | index file |
|---|---|---|---|---|
| `writer-js.ts` (`node:sqlite`) | 3937.0 ms | 3937.5 ms | **3937.5 ms** | 16.96 MiB |
| native, object transport | 451.8 ms | 52.7 ms | **57.2 ms** | 16.87 MiB |
| native, JSON-text transport | 461.7 ms | 8.9 ms | **10.7 ms** | 16.87 MiB |

The scaling is what the design predicts: the block grows with the input (the conversion is O(input)),
while the write grows with the output, off the loop.

How the numbers are taken (`tools/bench.mjs`): the block figure is a 4 ms `setInterval` sampler plus
`monitorEventLoopDelay`, warmed up before the call because the blocking chunk lands in the first
interval after it starts; the synchronous part of the call is measured directly and also counts as
blocking. For the JavaScript writer no timer can fire inside the call at all, which is why its sampler
contribution is zero while the loop was in fact frozen for the whole 2 seconds — its synchronous
measurement is the real block.

The write itself — 10 000 columns, 157 675 terms — is ~70 % term building and ~30 % SQLite. Making the
alias match precompute its word tokens took it from 698 ms to 225 ms; the first port tokenized 300
alias words per column.

## Parity

`tools/parity.mjs 500` — both writers, same catalog, same fixed `now`:

| catalog | js rows | rust rows | result |
|---|---|---|---|
| fixture (7 objects, 331 columns) | 7 / 331 / 7 / 1047 / 338 | identical | **all five tables identical** |
| synthetic (500 objects, 10 000 columns) | 500 / 10 000 / 1900 / 157 675 / 10 500 | identical | **all five tables identical** |

`search` is compared including its rowids, because both writers insert the documents in the same order
(object document, then its column documents) — a difference there means one side changed what it
indexes. `meta` differs in exactly one key: `writer` (`js` vs `rust`). File sizes differ by 0.5 %
(8 871 936 B vs 8 822 784 B) because the terms are inserted in a different order; SQLite page layout is
not part of the contract.

## Cross-boundary notes for the store

- **`meta`**: `schema_version`, `connection`, `engine`, `database`, `level`, `fetched_at`,
  `l1_indexed_at`, `writer` (`rust`), `written_at` are always written. `server_version` and
  `l2_indexed_at` are **omitted** when unknown — an absent key, not `''`, because the reader treats
  absence as unknown while `''` would coerce to epoch zero. `l1_indexed_at`/`fetched_at` carry the
  snapshot's `fetchedAt`; `l2_indexed_at` is written only for an `l2` run.
- **`search`**: one contentful FTS5 table. An object document carries `object_id` and a NULL
  `column_id`; a column document carries `column_id` and a NULL `object_id`. `text` is the token
  stream, so a query must be tokenized with the same function and joined with ` OR ` (a space is an
  FTS5 phrase).
- **`terms`**: object rows have `column_id IS NULL`, column rows carry both ids. Ordered by term.
- **Validation is stricter than the reference writer**: a duplicate `(schema_name, name)`, an empty
  name, a non-positive `ordinal` or a duplicate column name rejects with a message, where the
  JavaScript writer would rely on the SQLite constraint (or, for `ordinal`, accept it). This only
  diverges on input that is already wrong, and the error says which field.

## Known limits

- Input conversion of a JS **object** is the ceiling on how little the loop can be blocked (~3 µs per
  column, measured); the JSON-text transport is the way below it.
- A catalog over ~1 000 000 `serde_json` nodes is rejected by napi's conversion budget. A schema
  index that large is beyond what the store can rank usefully anyway.
- Comments are stored whole up to 2 000 characters; there is no per-object pruning.
