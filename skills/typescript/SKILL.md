---
description: TypeScript 5.x anti-patterns reference loaded by super-review:run when the diff touches TypeScript files. Covers `any` vs `unknown` discipline, type-assertion abuse, null/undefined drift, structural-vs-nominal ID confusion, exhaustiveness with `assertNever`, `Readonly<T>` shallowness, `enum` vs literal-union, decorator stage drift, missing `satisfies`, missing `using`/`await using`, loose generic constraints, `const` type params, and `NoInfer<T>` opportunities. Load when `*.ts` / `*.tsx` files in diff OR `tsconfig.json` modified.
---

# TypeScript review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies TypeScript files. `tsc --strict` and `@typescript-eslint` catch the obvious shape errors — what follows is the type-system residue they miss: places where the code compiles, lints clean, and is still wrong. Focused on TS 5.x features (satisfies, const type params, using/await using, NoInfer, Stage 3 decorators) because that's where AI reviewers trained on older corpora most often miss the right pattern.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness** and **Type Safety** reviewer prompts when it detects `*.ts`/`*.tsx` files in the diff or a `tsconfig.json` modification. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: `any` where `unknown` + narrowing is safe
**Detection signal:** Function param or return typed `any`, or `: any` annotation on a value that immediately gets accessed (`x.foo.bar`) without a type guard.
**Verbatim bad code:**
```ts
function parseConfig(input: any): Config {
  return { host: input.host, port: input.port };
}
parseConfig(JSON.parse(rawString)); // input.port is `any`, no error if it's a string
```
**Why it's wrong:** `any` disables checking on every downstream access — typos, wrong shapes, and unit mismatches all compile. `unknown` forces a narrowing step at the boundary.
**Fix:** Type the input as `unknown` and narrow with a guard or schema validator before access:
```ts
function parseConfig(input: unknown): Config {
  if (!isConfigShape(input)) throw new Error('bad config');
  return { host: input.host, port: input.port };
}
```
**Review prompt one-liner:** For every `any` in this diff, is there a reason a `unknown` + type guard (or Zod parse) would not have worked?

## Anti-pattern: Type assertion `as Foo` standing in for a real type guard
**Detection signal:** `as` casts on values that came from `JSON.parse`, `fetch().json()`, `req.body`, `localStorage`, or a function returning `unknown`/`any`.
**Verbatim bad code:**
```ts
const res = await fetch('/api/user').then(r => r.json());
const user = res as User;
console.log(user.email.toLowerCase()); // crashes if email is missing/number
```
**Why it's wrong:** `as` is a compiler-silencer, not a runtime check. The first time the API returns `{ email: null }` or `{}` you get a runtime `TypeError` with no stack near the parse site.
**Fix:** Validate at the boundary (`zod`, `valibot`, hand-rolled guard) so the type is *earned*, not *asserted*:
```ts
const user = UserSchema.parse(await fetch('/api/user').then(r => r.json()));
```
**Review prompt one-liner:** Does every `as T` cast in this diff have a corresponding runtime check upstream, or is it pure faith?

## Anti-pattern: `null` vs `undefined` drift across boundaries
**Detection signal:** DB layer (Prisma, Drizzle, raw SQL) returns `null` for missing columns, but domain code uses `?:` optional properties (which are `undefined`). Watch for `?? undefined` patches and `value === null || value === undefined` ladders.
**Verbatim bad code:**
```ts
type User = { name: string; bio?: string }; // bio is `string | undefined`
const row = await db.user.findUnique({ where: { id } }); // row.bio is `string | null`
const u: User = row!; // ✅ compiles, ❌ bio is now null in a slot typed undefined
if (u.bio) showBio(u.bio); // works
JSON.stringify(u); // serializes "bio": null, breaks downstream that checks `hasOwnProperty`
```
**Why it's wrong:** `null` and `undefined` serialize differently, behave differently with `??` vs `||`, and `Object.keys` sees `null` properties but not missing ones. Mixing them silently produces wire-format bugs.
**Fix:** Pick one convention per layer (`null` for "absent value present", `undefined` for "property missing") and convert *at the boundary*:
```ts
const u: User = { ...row, bio: row.bio ?? undefined };
```
**Review prompt one-liner:** Where DB rows enter domain types in this diff, is there an explicit `null → undefined` (or vice versa) conversion, or are the two leaking into the same shape?

## Anti-pattern: Structural collision — two domain IDs both typed `string`
**Detection signal:** Function signatures like `transfer(from: string, to: string, accountId: string)` — TS happily accepts arguments passed in the wrong order.
**Verbatim bad code:**
```ts
function chargeUser(userId: string, orderId: string, amountCents: number) { /* ... */ }
chargeUser(orderId, userId, 1999); // compiles, silently charges wrong user
```
**Why it's wrong:** TypeScript is structural. Two `string`s are the same type even if they mean wildly different things — IDs, slugs, emails, raw HTML.
**Fix:** Brand the type so the compiler tracks identity:
```ts
type UserId = string & { readonly __brand: 'UserId' };
type OrderId = string & { readonly __brand: 'OrderId' };
function chargeUser(userId: UserId, orderId: OrderId, cents: number) {}
// constructors live in one place: const asUserId = (s: string) => s as UserId;
```
**Review prompt one-liner:** Are any two arguments in this diff's function signatures the same primitive type but semantically distinct (user vs order vs session ID, cents vs dollars, raw vs sanitized HTML)?

## Anti-pattern: `catch (e)` typed as `any` (or worse, `Error`)
**Detection signal:** `catch (e: any)`, `catch (e: Error)`, or `tsconfig.json` missing `"useUnknownInCatchVariables": true` / `"strict": true` (which implies it since TS 4.4).
**Verbatim bad code:**
```ts
try { await op(); }
catch (e: any) {
  log(e.response.data.message); // e might be a string, AbortError, or DOMException
}
```
**Why it's wrong:** Throws can be *anything* in JS — strings, numbers, plain objects, `DOMException`, abort signals. Typing as `any` or `Error` hides this; the first non-Error throw crashes the handler.
**Fix:** Let TS type it as `unknown` (default with strict) and narrow:
```ts
catch (e) {
  if (e instanceof Error) log(e.message);
  else log(String(e));
}
```
**Review prompt one-liner:** Is `useUnknownInCatchVariables` on, and does every `catch` block narrow before access?

## Anti-pattern: Missing exhaustiveness check on discriminated-union switch
**Detection signal:** `switch (x.kind)` or `if/else if` ladder over a union's discriminant, with no `default` branch calling `assertNever`.
**Verbatim bad code:**
```ts
type Event = { kind: 'click' } | { kind: 'hover' } | { kind: 'submit' };
function handle(e: Event) {
  switch (e.kind) {
    case 'click': return onClick();
    case 'hover': return onHover();
    // 'submit' silently falls through; adding a new case breaks nothing visibly
  }
}
```
**Why it's wrong:** When someone later adds `'drag'` to `Event`, the switch silently returns `undefined` for the new case. No compile error.
**Fix:** Add an `assertNever` default so the compiler enforces total handling:
```ts
function assertNever(x: never): never { throw new Error(`Unhandled: ${JSON.stringify(x)}`); }
// in switch: default: return assertNever(e);
```
**Review prompt one-liner:** Does every switch/if-ladder over a union discriminant end in `assertNever` (or an equivalent exhaustive default)?

## Anti-pattern: `Readonly<T>` treated as deep — but it's shallow
**Detection signal:** `Readonly<{ items: T[] }>` or `ReadonlyArray<T>` of objects, with the assumption that nested fields can't be mutated.
**Verbatim bad code:**
```ts
function freeze(cart: Readonly<{ items: { qty: number }[] }>) {
  cart.items[0].qty = 999;     // ✅ compiles
  cart.items.push({ qty: 1 }); // ❌ caught, items: readonly[] would help
}
```
**Why it's wrong:** `Readonly<T>` only freezes the top level. Mutation through nested references compiles fine, breaking the "I got a frozen value" mental model.
**Fix:** Use a recursive `DeepReadonly` (utility-types, type-fest) or `as const` on literals; do not rely on `Readonly` for invariants:
```ts
type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
```
**Review prompt one-liner:** Where `Readonly<T>` or `ReadonlyArray<T>` is used as a safety boundary, does the type actually prevent the mutation that matters, or only the outermost assignment?

## Anti-pattern: Stage-3 decorators mixed with `experimentalDecorators`
**Detection signal:** `tsconfig.json` has `"experimentalDecorators": true` while code uses Stage 3 decorator shapes — `function log(value, context: ClassMethodDecoratorContext)` — or the reverse.
**Verbatim bad code:**
```jsonc
// tsconfig.json
{ "compilerOptions": { "target": "ES2022", "experimentalDecorators": true } }
```
```ts
// new-style decorator written against TS 5.0 Stage 3 semantics
function logged(value: Function, context: ClassMethodDecoratorContext) { /* ... */ }
class S { @logged greet() {} } // runs under legacy semantics, signature mismatch
```
**Why it's wrong:** TS 5.0 ships Stage 3 decorators with a different runtime contract (no `target/key/descriptor`, uses `context` object). With `experimentalDecorators: true`, TS uses the *legacy* semantics; your Stage 3 decorator either crashes at runtime or silently no-ops.
**Fix:** Pick one. For new code on TS 5.0+: remove `experimentalDecorators` and `emitDecoratorMetadata`. For frameworks still on legacy (NestJS, TypeORM, older Angular): keep `experimentalDecorators` and write decorators in the legacy 5-arg shape.
**Review prompt one-liner:** Does `tsconfig.json` opt into legacy decorators, and do all decorator implementations match that shape (legacy 5-arg vs Stage 3 `(value, context)`)?

## Anti-pattern: `enum` where a literal union + `as const` would be safer
**Detection signal:** `enum Status { Active, Inactive }` or `const enum`, especially with numeric values, used across module boundaries.
**Verbatim bad code:**
```ts
export enum Role { Admin, User, Guest }       // 0, 1, 2
db.update({ role: Role.User });                 // writes 1 to DB
// later someone reorders: enum Role { Guest, Admin, User }
// existing rows now mean wrong roles
```
**Why it's wrong:** Numeric enums are positional — reordering renumbers values, breaking persisted data. They also create a runtime object (bundle bloat), and `const enum` breaks under isolated-modules / bundlers like esbuild and SWC.
**Fix:** Literal-union + const object:
```ts
const Role = { Admin: 'admin', User: 'user', Guest: 'guest' } as const;
type Role = typeof Role[keyof typeof Role]; // 'admin' | 'user' | 'guest'
```
**Review prompt one-liner:** For every `enum`, would a `const` object + literal union have given the same ergonomics with fewer footguns (no positional drift, no const-enum bundler issues)?

## Anti-pattern: Missing `satisfies` where a wider annotation discards literal narrowing
**Detection signal:** `const x: Record<string, Handler> = { ... }` — the annotation widens keys to `string`, losing the literal key names for downstream lookups.
**Verbatim bad code:**
```ts
type Handler = (e: Event) => void;
const handlers: Record<string, Handler> = {
  click: e => e.preventDefault(),
  hover: e => e.preventDefault(),
};
handlers.clik;       // ✅ compiles — `string` index, no typo check
type Keys = keyof typeof handlers; // string, not 'click' | 'hover'
```
**Why it's wrong:** The annotation enforces the value shape but widens keys to `string`, killing typo detection and downstream `keyof` use.
**Fix:** Use `satisfies` (TS 4.9+) to validate without widening:
```ts
const handlers = {
  click: e => e.preventDefault(),
  hover: e => e.preventDefault(),
} satisfies Record<string, Handler>;
// keyof typeof handlers is now 'click' | 'hover'
handlers.clik; // ❌ Property 'clik' does not exist
```
**Review prompt one-liner:** For every object-literal config with a `: Record<…>` or `: Partial<…>` annotation, would `satisfies` preserve literal types that callers actually need?

## Anti-pattern: Resource cleanup via `try/finally` where `using` would be safer
**Detection signal:** `try { … } finally { handle.close() }` patterns, especially around DB transactions, file handles, locks, span timers, or `AbortController`. Project on TS 5.2+ with `lib: ["ES2023"]` or polyfill imported.
**Verbatim bad code:**
```ts
async function ingest(path: string) {
  const handle = await fs.open(path, 'r');
  try {
    const data = await handle.readFile();
    await process(data);
    if (data.length === 0) return; // ❌ if you add this, you must remember the close
  } finally {
    await handle.close();
  }
}
```
**Why it's wrong:** Manual cleanup is correct here but fragile: every new return/throw path needs the dev to remember `finally`. `await using` ties cleanup to scope exit automatically and stacks correctly across multiple resources.
**Fix:** TS 5.2 `using` / `await using` (Stage 3 explicit resource management):
```ts
async function ingest(path: string) {
  await using handle = await fs.open(path, 'r').then(h => ({
    ...h, [Symbol.asyncDispose]: () => h.close(),
  }));
  const data = await handle.readFile();
  await process(data);
} // handle disposed on scope exit, even on throw
```
**Review prompt one-liner:** Are there `try/finally` resource cleanups in this diff that would be cleaner as `using` / `await using` (TS 5.2+) — especially anywhere multiple resources are acquired sequentially?

## Anti-pattern: Generic constraint too loose, lets wrong types through
**Detection signal:** Bare `<T>` generics on functions that index into `T`, call `.length`, spread, or pass `T` to JSON serialization. Or `<T extends object>` where `unknown[]` slips through.
**Verbatim bad code:**
```ts
function pluck<T, K>(obj: T, key: K): T[K] {
  return obj[key]; // ❌ error: K not assignable to keyof T
}
// "fix" by widening:
function pluck<T, K extends string>(obj: T, key: K): unknown {
  return (obj as any)[key]; // compiles, returns unknown, lies about type
}
```
**Why it's wrong:** Loose constraints push the unsafety to the call site, where it shows up as `unknown` returns or runtime undefined access.
**Fix:** Constrain `K` to `keyof T`; for "any object" use `Record<string, unknown>` rather than `object` or `{}`:
```ts
function pluck<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
```
**Review prompt one-liner:** For every generic in this diff, is the constraint tight enough that wrong types are rejected at the call site instead of inside the function body?

## Anti-pattern: Missing `const` type parameter on literal-preserving APIs
**Detection signal:** Function signatures like `function pick<T extends string[]>(keys: T)` — callers pass `['id', 'name']` and get back `string[]` instead of `['id', 'name']`.
**Verbatim bad code:**
```ts
function fields<T extends string[]>(keys: T): T { return keys; }
const f = fields(['id', 'name']); // type: string[], not ['id','name']
type Picked = typeof f[number];   // string, not 'id' | 'name'
```
**Why it's wrong:** Without `const`, TS widens literal arrays to `string[]` at the call site; downstream type derivations collapse to `string`.
**Fix:** TS 5.0 `const` type parameter modifier:
```ts
function fields<const T extends readonly string[]>(keys: T): T { return keys; }
const f = fields(['id', 'name']); // type: readonly ['id', 'name']
type Picked = typeof f[number];   // 'id' | 'name'
```
**Review prompt one-liner:** For DSL-like helpers that take literal arrays/objects (column lists, route paths, enum keys), is the generic marked `const` so callers don't need to write `as const` themselves?

## Anti-pattern: Inference contaminated across params — missing `NoInfer<T>`
**Detection signal:** Two-or-more-arg generic functions where one param defines `T` and a *later* param should only be checked against it, not contribute to inference. Common shapes: `(default: T, allowed: T[])`, `(value: T, fallback: T)`, `(state: T, reducer: (s: T) => T)`.
**Verbatim bad code:**
```ts
function withDefault<T>(value: T, fallback: T): T { return value ?? fallback; }
withDefault('en', 'fr-CA'); // T inferred as 'en' | 'fr-CA' — widens past what caller wanted
const langs = ['en', 'fr'] as const;
withDefault<typeof langs[number]>('en', 'fr-CA'); // ❌ correctly errors only with explicit T
```
**Why it's wrong:** Both args contribute to `T` inference, so a typo in the second arg silently widens `T` instead of being rejected.
**Fix:** TS 5.4 `NoInfer<T>` blocks a position from participating in inference:
```ts
function withDefault<T>(value: T, fallback: NoInfer<T>): T { return value ?? fallback; }
withDefault('en' as 'en' | 'fr', 'fr-CA'); // ❌ now rejects 'fr-CA'
```
**Review prompt one-liner:** Are there multi-param generics where one position should *match* `T` but not *define* it — and is `NoInfer<T>` applied?

---

## What good looks like

### `satisfies` for config object literals
```ts
const routes = {
  home: { path: '/', auth: false },
  admin: { path: '/admin', auth: true },
} satisfies Record<string, { path: string; auth: boolean }>;

type RouteKey = keyof typeof routes; // 'home' | 'admin' — preserved
routes.home.path; // string, not widened
```
**Why it works:** Value shape validated; key/value literal types preserved for downstream `keyof`/lookups.
**Affirm:** Object-literal configs use `satisfies` (TS 4.9+), not `: SomeType` annotations that widen.

### Branded types for domain IDs
```ts
type UserId  = string & { readonly __brand: 'UserId' };
type OrderId = string & { readonly __brand: 'OrderId' };
const asUserId  = (s: string): UserId  => s as UserId;
const asOrderId = (s: string): OrderId => s as OrderId;

function charge(user: UserId, order: OrderId) {}
charge(asOrderId('o1'), asUserId('u1')); // ❌ type error
```
**Why it works:** Structural collisions between distinct-but-same-primitive IDs become compile errors; constructor functions are the single audit point.
**Affirm:** Domain identifiers (user/order/session IDs, cents/dollars, raw/sanitized HTML) use branded types, not bare `string`/`number`.

### Discriminated union + `assertNever` state machine
```ts
type Job =
  | { status: 'queued' }
  | { status: 'running'; pid: number }
  | { status: 'done'; output: string }
  | { status: 'failed'; error: Error };

function describe(j: Job): string {
  switch (j.status) {
    case 'queued':  return 'waiting';
    case 'running': return `pid ${j.pid}`;
    case 'done':    return j.output;
    case 'failed':  return j.error.message;
    default: return assertNever(j); // ❌ compile error when a new variant is added
  }
}
```
**Why it works:** Impossible states cannot be represented; new variants break the build until handled.
**Affirm:** State machines / event handlers use discriminated unions terminated by `assertNever`.

### `const` type parameter for literal preservation
```ts
function columns<const T extends readonly string[]>(cols: T): T { return cols; }
const c = columns(['id', 'name', 'email']);
type Col = typeof c[number]; // 'id' | 'name' | 'email'
```
**Why it works:** Callers get literal-preserving inference without writing `as const`; downstream `keyof`/index types stay narrow.
**Affirm:** DSL helpers that take literal arrays/objects mark their generic `const` (TS 5.0+).

### `unknown` + schema at every external boundary
```ts
import { z } from 'zod';
const Body = z.object({ email: z.string().email(), age: z.number().int().positive() });

app.post('/signup', (req, res) => {
  const parsed = Body.parse(req.body); // throws on bad shape
  return signup(parsed);                // typed, validated, narrow
});
```
**Why it works:** External input is never typed; the type is *earned* by parsing. Wire-format changes fail loudly at the edge instead of silently corrupting downstream logic.
**Affirm:** Every external boundary (`req.body`, `JSON.parse`, `fetch().json()`, `localStorage`, env vars) is validated with a schema, not asserted with `as`.

---

## Sources
- [TS 4.9 — satisfies operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [TS 5.0 — const type parameters](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#const-type-parameters)
- [TS 5.0 — Stage 3 decorators](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#decorators)
- [TS 5.2 — using / await using](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management)
- [TS 5.4 — NoInfer utility](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html#the-noinfer-utility-type)
- [TS 4.4 — useUnknownInCatchVariables](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-4.html#defaulting-to-the-unknown-type-in-catch-variables---useunknownincatchvariables)
- [TS handbook — Discriminated unions & `never`](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking)
