---
description: ORM-layer anti-patterns reference loaded by super-review:run. Covers Prisma 5/6, MikroORM 6, TypeORM, Drizzle. N+1, transaction propagation, identity map, soft-delete bypass, raw SQL escape hatches, Prisma 6 breaking changes (Bytes→Uint8Array, NotFoundError removed). Load when an ORM is detected in package.json.
---

# ORM review reference

ORM-layer anti-patterns for Correctness + Performance reviewers in [`super-review:run`](../run/SKILL.md). Auto-loaded when `prisma`, `@mikro-orm/core`, `typeorm`, `drizzle-orm` etc. are detected.

---

## Anti-pattern: N+1 from forgotten include on a conditional branch
**Detection signal:** A loop after an ORM query that accesses a relation field whose `include`/`populate` was only set on the happy path.
**Verbatim bad code:**
```ts
const users = await prisma.user.findMany({
  where: { active: true },
  include: req.includeOrders ? { orders: true } : undefined,
});
for (const u of users) {
  total += u.orders?.reduce((s, o) => s + o.total, 0) ?? 0; // lazy fetch if include skipped
}
```
**Why it's wrong:** Prisma doesn't lazy-load — `u.orders` is `undefined`, the `?? 0` masks the bug, and the totals are silently zero. In MikroORM the same pattern *does* lazy-fetch, producing N round-trips.
**Fix:** Move the include condition out: always include when the loop reads relations; or use a `select` that throws on missing rather than `undefined`.
**Review prompt one-liner:** Any loop touching `entity.relation` after an ORM fetch must have that relation unconditionally included.

## Anti-pattern: Prisma `$transaction` callback that captures the outer client
**Detection signal:** Inside `prisma.$transaction(async (tx) => { ... })`, calls to `prisma.foo` (not `tx.foo`).
**Verbatim bad code:**
```ts
await prisma.$transaction(async (tx) => {
  const u = await tx.user.create({ data });
  await prisma.profile.create({ data: { userId: u.id } }); // outside the tx!
});
```
**Why it's wrong:** Only `tx.*` calls participate in the transaction; `prisma.*` runs on a fresh connection and commits independently — partial writes survive a rollback.
**Fix:** Always shadow the name (`async (prisma) => ...`) or lint-rule the use of the outer client inside transaction callbacks.
**Review prompt one-liner:** Inside any `$transaction` callback, no reference to the outer Prisma client.

## Anti-pattern: Drizzle helper called with global `db` from inside `tx`
**Detection signal:** A helper signature `async function createUser(data)` that calls `db.insert(...)` — called from inside `await db.transaction(async (tx) => createUser(data))`.
**Verbatim bad code:**
```ts
async function awardPoints(userId: number) {
  return db.update(users).set({ points: sql`points + 10` }).where(eq(users.id, userId));
}
await db.transaction(async (tx) => {
  await tx.insert(orders).values(o);
  await awardPoints(o.userId); // runs OUTSIDE the tx
});
```
**Why it's wrong:** Drizzle docs require explicit `tx` passing — there's no AsyncLocalStorage propagation. The points update is non-transactional and survives rollback.
**Fix:** Every helper that may run inside a transaction takes `tx: typeof db | Transaction` as its first arg; pass it through.
**Review prompt one-liner:** Drizzle helpers that write must accept and use an explicit transaction handle — no closing over a module-scoped `db`.

## Anti-pattern: MikroORM shared EntityManager across requests
**Detection signal:** A singleton `em` imported in route handlers without `em.fork()` per request.
**Verbatim bad code:**
```ts
import { em } from './orm';
app.get('/users/:id', async (req, res) => {
  const u = await em.findOne(User, req.params.id);
  res.json(u);
});
```
**Why it's wrong:** MikroORM docs: "You should always keep unique identity map per each request" — sharing leaks memory ("growing memory footprint, as every entity that became managed... would be kept in the Identity Map") and produces unstable responses because one request's `populate` state leaks into another's.
**Fix:** `RequestContext.create(em, next)` middleware, or explicit `em.fork()` at the top of every handler.
**Review prompt one-liner:** Every MikroORM request handler must obtain its EM via `RequestContext` or `em.fork()`.

## Anti-pattern: `$queryRawUnsafe` / `manager.query` with string interpolation
**Detection signal:** Template literals containing user input passed to `$queryRawUnsafe`, `em.execute`, `manager.query`, or `db.execute(sql.raw(...))`.
**Verbatim bad code:**
```ts
const rows = await prisma.$queryRawUnsafe(
  `SELECT * FROM users WHERE email = '${email}'`
);
```
**Why it's wrong:** Bypasses parameter binding — classic SQL injection. The `Unsafe` suffix exists precisely because the safe `$queryRaw` tagged-template form is one keystroke away.
**Fix:** `prisma.$queryRaw\`SELECT * FROM users WHERE email = ${email}\`` (tagged template binds parameters); for Drizzle use `sql\`... ${email}\``; for MikroORM use `em.getConnection().execute(sql, [email])`.
**Review prompt one-liner:** Any `Unsafe`/`.query(string)` call with a non-literal must be flagged — switch to the tagged-template variant.

## Anti-pattern: Soft-delete global filter missed by a join
**Detection signal:** ORM filter/global scope that hides `deleted_at IS NOT NULL`, plus a raw join or `include` on a relation that doesn't apply the filter.
**Verbatim bad code:**
```ts
// MikroORM filter on Post hides deleted posts
@Filter({ name: 'soft', cond: { deletedAt: null }, default: true })
class Post { @ManyToOne() author!: User; }
// But:
await em.find(User, {}, { populate: ['posts'] });
// User has no soft-delete filter — populates deleted posts through the FK.
```
**Why it's wrong:** Filters are per-entity; the populated side bypasses the filter unless explicitly enabled there too. Prisma has no global soft-delete at all — every query must pass the predicate manually.
**Fix:** Apply soft-delete predicates at the database view layer (`CREATE VIEW active_posts AS ...`), or enforce filter on both ends with a unit test that queries deleted rows through every relation.
**Review prompt one-liner:** Any soft-delete scheme must be enforced at the view/RLS layer, not as an ORM-only filter.

## Anti-pattern: Default `SELECT *` returning sensitive fields
**Detection signal:** `findMany`/`findOne` without explicit `select`/`fields`, on an entity that has password hash, internal tokens, or PII.
**Verbatim bad code:**
```ts
const user = await prisma.user.findUnique({ where: { id } });
res.json(user); // includes passwordHash, mfaSecret, stripeCustomerId
```
**Why it's wrong:** ORMs default to all columns; serializing the entity directly leaks fields the API contract never promised.
**Fix:** Always `select: { id: true, email: true, ... }` for response shapes, or pass through a DTO; in MikroORM use `wrap(u).toJSON()` with `@Serializer`/hidden fields.
**Review prompt one-liner:** ORM result objects must never be passed to `res.json` without an explicit `select` or DTO mapping.

## Anti-pattern: Singleton Prisma client per Lambda invocation
**Detection signal:** `new PrismaClient()` at module top level in a serverless handler without `__prisma` global guard, or per-request `new PrismaClient()` in a long-running server.
**Verbatim bad code:**
```ts
// every cold start + warm reuse leaks connections
export const handler = async (event) => {
  const prisma = new PrismaClient();
  return prisma.user.findMany();
};
```
**Why it's wrong:** Each `new PrismaClient()` opens a connection pool; serverless concurrency × pool size saturates Postgres `max_connections` in minutes.
**Fix:** Module-scoped singleton with `global.__prisma ??= new PrismaClient()`; in serverless, point at Prisma Accelerate / a pooler and set `connection_limit=1`.
**Review prompt one-liner:** Exactly one `new PrismaClient()` per process; serverless paths must use a global cache and a pooled URL.

## Anti-pattern: Prisma 6 `Buffer` assumption on Bytes field
**Detection signal:** Code that calls `.toString('utf8')`, `Buffer.concat`, or `.buffer` on a `Bytes` field result.
**Verbatim bad code:**
```ts
const file = await prisma.file.findUnique({ where: { id } });
const text = file.data.toString('utf8'); // throws or returns "[object Uint8Array]"
```
**Why it's wrong:** Prisma 6 docs: "Prisma v6 replaces the usage of `Buffer` with `Uint8Array` to represent fields of type `Bytes`." `Uint8Array.prototype.toString()` doesn't accept an encoding argument — silent wrong output.
**Fix:** Use `Buffer.from(file.data).toString('utf8')` or `new TextDecoder().decode(file.data)`.
**Review prompt one-liner:** After upgrading to Prisma 6, every `.toString('utf8')` on a `Bytes` field is a bug — wrap in `Buffer.from()` or `TextDecoder`.

## Anti-pattern: `findUniqueOrThrow` catching the wrong error class
**Detection signal:** `catch (e) { if (e instanceof NotFoundError) ... }`.
**Verbatim bad code:**
```ts
try {
  return await prisma.user.findUniqueOrThrow({ where: { id } });
} catch (e) {
  if (e instanceof Prisma.NotFoundError) return null; // class removed in v6
  throw e;
}
```
**Why it's wrong:** Prisma 6 docs: "`NotFoundError` has been removed... catch `PrismaClientKnownRequestError` with error code `P2025`." Existing `instanceof` checks silently never match — 404s become 500s.
**Fix:** `if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025')`.
**Review prompt one-liner:** Post-Prisma-6, no reference to `NotFoundError` — catch `P2025` on `PrismaClientKnownRequestError` instead.

## Sources
- [Prisma — v6 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-6)
- [MikroORM — identity map](https://mikro-orm.io/docs/identity-map)
- [Drizzle — transactions](https://orm.drizzle.team/docs/transactions)
