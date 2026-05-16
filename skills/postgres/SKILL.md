---
description: Postgres 16/17/18 anti-patterns reference loaded by super-review:run. Covers lock escalation, deadlocks, MVCC pressure, JSONB indexing, partial indexes, CTE materialization, isolation retries, pgBouncer modes, PG17 MERGE pitfalls, PG18 virtual generated columns, REPLICA IDENTITY. Load when Postgres is detected in stack or migrations/sql files are in the diff.
---

# Postgres review reference

Modern (PG16/17/18) anti-patterns for the Migration/DB and Performance reviewers in [`super-review:run`](../run/SKILL.md). Auto-loaded when migrations are present or `pg`/`postgres` is in the dep tree.

---

## Anti-pattern: `SELECT ... FOR UPDATE` on parent when only FK is read
**Detection signal:** `FOR UPDATE` on a row whose only purpose is to gate inserts on a child table.
**Verbatim bad code:**
```sql
BEGIN;
SELECT * FROM users WHERE id = $1 FOR UPDATE;
INSERT INTO orders (user_id, total) VALUES ($1, $2);
COMMIT;
```
**Why it's wrong:** Blocks every other writer touching that user row (profile update, login timestamp) even though we only need the FK to exist; under load the user row becomes a hotspot.
**Fix:** Use `FOR NO KEY UPDATE` — it still prevents row deletion/key change but doesn't block non-key UPDATEs or other FK references.
**Review prompt one-liner:** Any `FOR UPDATE` taken only to validate a foreign key should be `FOR NO KEY UPDATE`.

## Anti-pattern: Deadlock from inconsistent multi-row lock ordering
**Detection signal:** Two code paths that lock the same set of rows in different orders (e.g., `WHERE id IN (...)` without `ORDER BY id`).
**Verbatim bad code:**
```ts
// Path A
await tx.$executeRaw`SELECT id FROM accounts WHERE id = ANY(${ids}) FOR UPDATE`;
// Path B (transfer)
await tx.$executeRaw`SELECT id FROM accounts WHERE id IN (${to}, ${from}) FOR UPDATE`;
```
**Why it's wrong:** Postgres locks rows in the order they're encountered by the executor; concurrent transactions locking `{1,2}` vs `{2,1}` deadlock and one is aborted.
**Fix:** Always sort lock targets deterministically (`ORDER BY id`) before `FOR UPDATE`, or use a single advisory lock keyed on a canonical hash of the set.
**Review prompt one-liner:** Every multi-row `FOR UPDATE` must be preceded by `ORDER BY` on a stable key.

## Anti-pattern: `idle in transaction` from awaiting external I/O inside `BEGIN`
**Detection signal:** `await fetch(...)`, `await stripe.charges.create(...)`, or any network call between `BEGIN` and `COMMIT`.
**Verbatim bad code:**
```ts
await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data });
  const charge = await stripe.charges.create({ amount, source }); // network!
  await tx.order.update({ where: { id: order.id }, data: { chargeId: charge.id } });
});
```
**Why it's wrong:** Transaction holds row locks + xmin horizon for the duration of the HTTP call; one slow upstream pins vacuum, bloats hot tables, and exhausts the pool.
**Fix:** Two-phase write: create order in tx, charge outside, then a second tx to attach charge id (or use an outbox).
**Review prompt one-liner:** No network or filesystem I/O inside `prisma.$transaction` / `em.transactional` / `db.transaction` callbacks.

## Anti-pattern: GIN index on JSONB used with `->` (jsonb) when query uses `->>` (text)
**Detection signal:** `CREATE INDEX ... USING gin (data jsonb_path_ops)` but queries written as `WHERE data->>'status' = 'paid'`.
**Verbatim bad code:**
```sql
CREATE INDEX idx_orders_data ON orders USING gin (data jsonb_path_ops);
-- Query
SELECT * FROM orders WHERE data->>'status' = 'paid';
```
**Why it's wrong:** `jsonb_path_ops` only supports `@>` containment; `->>` returns text and never uses the GIN index — sequential scan in production.
**Fix:** Either rewrite as `WHERE data @> '{"status":"paid"}'`, or create an expression btree: `CREATE INDEX ON orders ((data->>'status'))`.
**Review prompt one-liner:** Any `data->>'key' = X` predicate needs an expression index on `(data->>'key')`, not a generic GIN.

## Anti-pattern: Partial index that the planner can't prove applies
**Detection signal:** `CREATE INDEX ... WHERE deleted_at IS NULL` but ORM emits `WHERE deleted_at = NULL` or omits the predicate entirely.
**Verbatim bad code:**
```sql
CREATE INDEX active_users_email ON users (email) WHERE deleted_at IS NULL;
-- ORM emits:
SELECT * FROM users WHERE email = $1 AND deleted_at IS :null;  -- parameterized NULL check
```
**Why it's wrong:** Planner needs the literal predicate `deleted_at IS NULL` in the query to match a partial index; a parameterized null doesn't match and the planner falls back to a full table scan or another less-selective index.
**Fix:** Hard-code the partial predicate in the ORM filter (or via Prisma `@@index([email], where: ...)` — preview) and verify with `EXPLAIN`.
**Review prompt one-liner:** Every partial index must have its WHERE clause literally reproduced in every query that should use it.

## Anti-pattern: CTE assumed to materialize on PG12+
**Detection signal:** `WITH x AS (SELECT ...)` used as a "barrier" to control plan order, no `MATERIALIZED` keyword.
**Verbatim bad code:**
```sql
WITH recent AS (
  SELECT * FROM events WHERE created_at > now() - interval '1 day'
)
SELECT * FROM recent WHERE user_id = $1;
```
**Why it's wrong:** Since PG12, non-recursive single-use CTEs are inlined; the optimizer may push the `user_id` filter down and choose a wildly different plan than the author intended (sometimes worse if statistics are stale).
**Fix:** If you need a fence, use `WITH recent AS MATERIALIZED (...)`. If you want inline behavior, you already have it — drop the CTE entirely and use a subquery.
**Review prompt one-liner:** Any CTE relied on as an optimization fence must say `AS MATERIALIZED` explicitly.

## Anti-pattern: SERIALIZABLE without a retry loop
**Detection signal:** `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` or Prisma `isolationLevel: 'Serializable'` with no error handler for `40001`.
**Verbatim bad code:**
```ts
await prisma.$transaction(async (tx) => { ... }, { isolationLevel: 'Serializable' });
```
**Why it's wrong:** Serializable transactions are *expected* to abort with `serialization_failure` (SQLSTATE `40001`) under contention; without retry the caller sees random 500s in production.
**Fix:** Wrap in a retry loop (3–5 attempts, exponential backoff) that only retries on `40001` and `40P01`.
**Review prompt one-liner:** Every `Serializable` transaction must have an explicit `40001` retry loop.

## Anti-pattern: pgBouncer transaction mode + session-scoped state
**Detection signal:** Use of `pg_advisory_lock`, `LISTEN`, `SET` (without `LOCAL`), `PREPARE`, or unscoped temp tables.
**Verbatim bad code:**
```ts
await db.execute(sql`SELECT pg_advisory_lock(${key})`);
// do work
await db.execute(sql`SELECT pg_advisory_unlock(${key})`); // different connection!
```
**Why it's wrong:** pgBouncer docs say session-level advisory locks, `SET/RESET`, `LISTEN`, `PREPARE/DEALLOCATE`, `LOAD`, and `PRESERVE/DELETE ROWS temp tables` work "Never" in transaction mode — each statement may land on a different backend.
**Fix:** Use `pg_advisory_xact_lock` (auto-released on COMMIT) and `SET LOCAL` for GUCs; if you need session state, route through session-mode pool on a separate port.
**Review prompt one-liner:** When pgBouncer transaction pooling is in play, ban `pg_advisory_lock`, `LISTEN`, bare `SET`, and `PREPARE` — only their transaction-scoped equivalents are safe.

## Anti-pattern: PG17 `MERGE` used as a race-safe UPSERT
**Detection signal:** `MERGE INTO ... USING (VALUES ...) ... WHEN NOT MATCHED THEN INSERT` in a high-concurrency path.
**Verbatim bad code:**
```sql
MERGE INTO inventory t USING (VALUES ($1,$2)) v(sku, qty)
ON t.sku = v.sku
WHEN MATCHED THEN UPDATE SET qty = t.qty + v.qty
WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (v.sku, v.qty);
```
**Why it's wrong:** PG17 docs explicitly state MERGE under READ COMMITTED can raise unique-violation when a concurrent INSERT happens between the join and the action: "You may also wish to consider using `INSERT ... ON CONFLICT` as an alternative statement which offers the ability to run an `UPDATE` if a concurrent `INSERT` occurs."
**Fix:** `INSERT ... ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty` for true UPSERT; reserve MERGE for batch-load scenarios where you control concurrency.
**Review prompt one-liner:** UPSERTs use `INSERT ... ON CONFLICT`, not `MERGE`, unless the path is single-writer.

## Anti-pattern: PG18 virtual generated column used in an index or FK
**Detection signal:** `GENERATED ALWAYS AS (...) VIRTUAL` paired with `CREATE INDEX` on the column, or used in logical replication.
**Verbatim bad code:**
```sql
ALTER TABLE orders ADD COLUMN total_cents int GENERATED ALWAYS AS (price * qty) VIRTUAL;
CREATE INDEX idx_orders_total ON orders (total_cents);  -- recomputed every read
```
**Why it's wrong:** Virtual generated columns occupy no storage and are recomputed at read time; PG18 docs note logical replication "is currently only supported for stored generated columns," and a virtual column expression must not use user-defined functions or types.
**Fix:** Use `STORED` if you need indexing performance or logical replication; or use an expression index `CREATE INDEX ON orders ((price*qty))` and skip the generated column.
**Review prompt one-liner:** Any indexed or logically replicated generated column must be `STORED`, not `VIRTUAL`.

## Anti-pattern: `REPLICA IDENTITY` left at default on UPDATE-heavy table
**Detection signal:** Logical publication on a table whose primary key isn't on the update predicate, or no PK at all.
**Verbatim bad code:**
```sql
CREATE PUBLICATION app_pub FOR TABLE events;
-- events has no PK, REPLICA IDENTITY DEFAULT
UPDATE events SET processed = true WHERE batch_id = $1;
```
**Why it's wrong:** Default replica identity uses the PK; without one, UPDATE/DELETE on a published table errors with "cannot update table 'events' because it does not have a replica identity." Setting `REPLICA IDENTITY FULL` works but every UPDATE writes the whole old row to WAL — slot bloat.
**Fix:** Add a PK or `REPLICA IDENTITY USING INDEX` on a unique, NOT NULL index; reserve `FULL` for low-write tables.
**Review prompt one-liner:** Any table in a logical publication needs a PK or an explicit `REPLICA IDENTITY USING INDEX` — never default `FULL` on a hot table.

## What good looks like

### `INSERT ... ON CONFLICT` for race-safe upsert
```sql
INSERT INTO inventory (sku, qty) VALUES ($1, $2)
ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty
RETURNING qty;
```
**Why it works:** Single atomic statement; concurrent inserts of the same SKU serialize correctly; no MERGE unique-violation pitfall.
**Affirm:** Upserts use `INSERT ... ON CONFLICT`, not `SELECT` + `INSERT`-or-`UPDATE` round-trips.

### `FOR NO KEY UPDATE` for FK-existence gates
```sql
BEGIN;
SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE;
INSERT INTO orders (user_id, total) VALUES ($1, $2);
COMMIT;
```
**Why it works:** Prevents row deletion / PK change but doesn't block concurrent profile updates; user row stays a non-hotspot.
**Affirm:** Locks taken only to gate FK validity use `FOR NO KEY UPDATE`, never `FOR UPDATE`.

### `pg_advisory_xact_lock` for app-level mutexes under pgBouncer
```sql
SELECT pg_advisory_xact_lock(hashtext('rebuild_index'));
-- work happens; lock released automatically on COMMIT
```
**Why it works:** Transaction-scoped lock survives pgBouncer transaction-pooling; auto-released; no manual `pg_advisory_unlock` (which would land on a different backend).
**Affirm:** Every advisory lock in a project using pgBouncer is `_xact_lock` variant.

### `SERIALIZABLE` wrapped in a retry helper
```ts
async function txWithRetry<T>(fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await prisma.$transaction(fn, { isolationLevel: 'Serializable' }); }
    catch (e: any) { if (e.code !== '40001' && e.code !== '40P01') throw e; await sleep(50 * 2 ** i); }
  }
  throw new Error('tx retries exhausted');
}
```
**Why it works:** Serialization failures retry transparently with exponential backoff; callers see consistent results, not random 500s.
**Affirm:** All SERIALIZABLE transactions go through a retry helper that catches `40001`/`40P01`.

### NOT NULL column added as 3 separate migrations (zero-downtime)
```
migration_1: ALTER TABLE ... ADD COLUMN status text;  -- nullable, default null
migration_2: backfill in batches: UPDATE ... SET status = 'pending' WHERE status IS NULL;
migration_3: ALTER TABLE ... ALTER COLUMN status SET NOT NULL, SET DEFAULT 'pending';
```
**Why it works:** Each step is independently deployable; no long-running ACCESS EXCLUSIVE lock from `SET NOT NULL` on a populated table; rollback-safe.
**Affirm:** NOT NULL added to existing table is split into nullable-add → backfill → set-not-null.

## Sources
- [PostgreSQL — `FOR UPDATE` / `FOR NO KEY UPDATE`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL 17 — MERGE concurrency note](https://www.postgresql.org/docs/17/sql-merge.html)
- [PostgreSQL 18 — Generated columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html)
- [pgBouncer — Feature matrix](https://www.pgbouncer.org/features.html)
