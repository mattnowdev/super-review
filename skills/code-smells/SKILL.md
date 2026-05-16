---
description: Code-smell catalog (Fowler / refactoring.guru) adapted for PR review. Covers Bloaters (Long Method, Large Class, Primitive Obsession, Long Parameter List, Data Clumps), OO Abusers (Switch Statements, Temporary Field, Refused Bequest), Change Preventers (Divergent Change, Shotgun Surgery), Dispensables (Duplicate Code, Dead Code, Speculative Generality, Comments-as-explanation), Couplers (Feature Envy, Inappropriate Intimacy, Message Chains, Middle Man), plus Flag Arguments, Stringly Typed, Magic Numbers. Load when the diff has a large single-file change (>150 LOC), a new class with >5 methods, function moves across files, or the user explicitly asks for a refactor review.
---

# Code-smells review reference

Refactoring.guru / Fowler-style code smells adapted for PR review. Loaded by [`super-review:run`](../run/SKILL.md) when:
- single-file diff > 150 LOC modified (suggests refactor or new feature)
- new class/module added with > 5 methods
- functions moved between files (rename detection in `git diff`)
- explicit `/super-review:run smells` invocation
- Correctness/Design reviewer requests deep look

**Calibration rule:** smells are *suggestions*, not bugs. Flag only when load-bearing — the smell currently causes pain, blocks a near-future change the team is planning, or doubles in cost with the diff. A single instance of "Long Method" in a leaf utility is a nit; a Long Method in a class that's about to be reused is a finding.

---

## Bloaters

### Long Method
**Detection signal:** function body > 50 lines, nested loops 3+ deep, > 8 local variables, > 5 distinct levels of abstraction in one body.
**Bad example:**
```ts
async function processOrder(input) {
  // 80+ lines: validate, compute pricing, charge, log, email, audit, return
}
```
**Why it's a smell:** Each abstraction level should fit in a function; mixed levels obscure intent and make every change touch unrelated logic.
**Fix:** Extract Method along intent lines (`validate()`, `applyPricing()`, `charge()`, `notify()`). Each extracted method should be nameable in 3-5 words without "And".
**Review prompt one-liner:** Can this function be re-described in one sentence without using "and"? If not, propose specific extractions.

### Large Class (God Object)
**Detection signal:** class file > 400 LOC, > 15 public methods, > 8 instance fields, > 4 distinct responsibilities (data fetching + validation + rendering + persistence in one class).
**Bad example:**
```ts
class UserService { // 600 lines: auth + profile + billing + email + audit
  login() ... register() ... charge() ... refund() ... sendWelcome() ...
}
```
**Why it's a smell:** SRP violation; one team owns too much; tests are slow + brittle; refactoring one concern touches every consumer.
**Fix:** Extract Class along concern boundaries (`AuthService`, `BillingService`, `NotificationService`). Use composition or a facade if call sites can't change yet.
**Review prompt one-liner:** Name the single responsibility of this class in one sentence. If the answer needs "and" or commas, propose the split.

### Primitive Obsession
**Detection signal:** function signatures with multiple `string`/`number` params that conceptually represent one domain object; IDs of different types passed as the same `string`; money/duration/percentage as raw `number`.
**Bad example:**
```ts
function transfer(fromId: string, toId: string, amount: number, currency: string) {}
// caller: transfer(userId, accountId, 1000, "USD")  // wait, did I get the order right?
```
**Why it's a smell:** Type system can't catch swapped arguments (`fromId`/`toId`), invalid currency, negative amount. Validation duplicated across call sites.
**Fix:** Introduce branded types or value objects (`UserId`, `AccountId`, `Money({amount, currency})`). Validation runs once at construction.
**Review prompt one-liner:** Any function parameter typed as raw `string`/`number` that represents a domain concept (ID, money, time, percentage) — wrap in a branded type or value object.

### Long Parameter List
**Detection signal:** function with > 4 parameters, especially when several share a domain (`createUser(firstName, lastName, email, phone, address, city, zip, country, role)`).
**Bad example:**
```ts
function searchOrders(userId, from, to, status, minAmount, maxAmount, currency, sortBy, sortDir, limit, offset) {}
```
**Why it's a smell:** Call sites are unreadable; positional args invite bugs; adding a param is a breaking change to every caller.
**Fix:** Introduce Parameter Object (`searchOrders(criteria: OrderSearchCriteria)`). Group related params (pagination, range filters, sort).
**Review prompt one-liner:** Function takes > 4 params — propose a parameter object grouping the obvious clusters.

### Data Clumps
**Detection signal:** the same 3+ fields appear together in multiple function signatures, class properties, or DTOs (`firstName`/`lastName`/`email` everywhere; `street`/`city`/`zip` everywhere).
**Bad example:**
```ts
function ship(street, city, zip, country) {}
function tax(street, city, zip, country) {}
function display(street, city, zip, country) {}
```
**Why it's a smell:** Adding a new field (`stateProvince` for non-US) means N coordinated edits; bugs slip in when one site forgets to pass the new field.
**Fix:** Extract Class — make `Address` an object passed as one parameter; validation + formatting can live on it.
**Review prompt one-liner:** Any group of 3+ params/fields that always travel together is a hidden domain object — extract it.

---

## Object-Orientation Abusers

### Switch Statements (type-based dispatch)
**Detection signal:** `switch (type)` or chained `if/else if` on a discriminator that recurs in multiple files; new variant requires editing every switch.
**Bad example:**
```ts
function area(shape) {
  switch (shape.type) {
    case 'circle': return Math.PI * shape.r ** 2;
    case 'square': return shape.side ** 2;
    case 'triangle': return 0.5 * shape.base * shape.height;
  }
}
```
**Why it's a smell:** Open/Closed violation — adding `Rectangle` requires touching `area()`, `perimeter()`, `draw()`, every other switch. Lookup-by-type is a recurring search-and-replace cost.
**Fix:** Replace Conditional with Polymorphism (subclass per variant) or table dispatch (`const HANDLERS = { circle, square, ... }`). For exhaustiveness, TypeScript discriminated unions + `assertNever(x: never)` catch missing branches.
**Review prompt one-liner:** Any switch/if-chain on a `type` discriminator that recurs in > 2 files — propose polymorphism or a dispatch table.

### Temporary Field
**Detection signal:** class field that's `null`/`undefined` except during a specific operation; `if (this.temp) { ... }` guards scattered around.
**Bad example:**
```ts
class Order {
  private intermediateTotal: number | null = null; // only set during checkout
  checkout() { this.intermediateTotal = computeBase(); /* ... */ this.intermediateTotal = null; }
}
```
**Why it's a smell:** Hidden temporal coupling — reading the field outside `checkout()` returns null silently; methods can't be reasoned about in isolation.
**Fix:** Extract Class for the algorithm that needs the field (`CheckoutCalculator` holds it as a local), or replace with method parameter passed through call chain.
**Review prompt one-liner:** Any field that's null except during one operation — pull the operation + field into its own class or use locals.

### Refused Bequest
**Detection signal:** subclass overrides parent method to throw, return early, or no-op; subclass uses < 30% of parent's API.
**Bad example:**
```ts
class ReadOnlyList extends List {
  add(item) { throw new Error('not supported'); }
  remove(item) { throw new Error('not supported'); }
}
```
**Why it's a smell:** Inheritance is being used for code reuse, not is-a — LSP violated, callers depending on `List` interface break.
**Fix:** Replace Inheritance with Delegation (`ReadOnlyList` holds a `List`, exposes only read methods), or extract a shared `ReadableList` interface that `List` and `ReadOnlyList` both implement.
**Review prompt one-liner:** Any subclass overriding to throw/no-op > 1 parent method — replace inheritance with composition.

---

## Change Preventers

### Divergent Change
**Detection signal:** one class is modified for multiple unrelated reasons across recent commits (database migration changed it last month, UI change changed it this month, billing change next month).
**Bad example:** `User` class touched by every team in the org — auth team, billing team, profile team, notification team.
**Why it's a smell:** Cross-team merge conflicts; every release risks regression in unrelated features; tests for one concern slow down because they import the whole graph.
**Fix:** Extract Class per change axis. If unsure where the seams are, run `git log -p <file>` over the last 6 months and look at which commit groups touch which lines.
**Review prompt one-liner:** Is this PR's change to file X the same kind of change the last 3 PRs to file X made? If not, propose a split.

### Shotgun Surgery
**Detection signal:** simple-sounding change touches N files (e.g. "add a new role" requires editing the enum, the auth check in 8 services, the migration, the seed, the test fixtures, the docs).
**Bad example:**
```diff
+ role: 'editor' | 'viewer' | 'admin' | 'auditor'  // added 'auditor'
// 14 other files also touched
```
**Why it's a smell:** A concept that should be cohesive is scattered; every related change is high-risk and easy to miss a site.
**Fix:** Move Method / Move Field to consolidate. Introduce a single source of truth (a `Role` module that owns enum + checks + serialization + UI labels in one place).
**Review prompt one-liner:** If this PR touches the same concept across > 4 files, propose where that concept should live as one module.

---

## Dispensables

### Duplicate Code
**Detection signal:** identical or near-identical logic in 2+ places (`if (user.role === 'admin' || user.role === 'owner')` in 6 controllers); copy-paste with one tweak ("almost the same but slightly different").
**Bad example:**
```ts
// controller A:
if (user.role === 'admin' || user.role === 'owner') { ... }
// controller B:
if (user.role === 'owner' || user.role === 'admin') { ... }  // same, reordered
```
**Why it's a smell:** Inevitable divergence — one site gets a fix the other misses; semantic drift; the "1% different" version masks a real bug.
**Fix:** Extract Method/Function. For near-duplicates, parameterize the difference (`isWriter(user)` / `isPriv(user, level)`).
**Review prompt one-liner:** Same logic appears in > 1 place — extract or accept the duplication consciously (note why).

### Dead Code
**Detection signal:** unused exports, unreachable branches (`if (false) {}`, code after `return`), commented-out blocks, parameters that no caller passes, dead env vars.
**Bad example:**
```ts
export function oldHandler(req) { /* not called anywhere */ }
function process(x, _legacy) { return x * 2; } // _legacy never used
```
**Why it's a smell:** Carries cognitive load ("is this dead or am I misreading the wiring?"); blocks rename refactors; tests for it pollute coverage.
**Fix:** Delete. Git remembers; commented-out code is never "saved for later" — it ships unmaintained.
**Review prompt one-liner:** Any unused export, unreachable branch, or commented-out block — delete it in this PR or open an issue to delete.

### Speculative Generality (YAGNI)
**Detection signal:** abstraction with one concrete implementation; config option no one sets; plugin interface for a single plugin; generic name for a specific use (`Manager`, `Processor`, `Handler` for one thing).
**Bad example:**
```ts
interface NotificationProvider { send(msg: string): Promise<void>; }
class EmailNotificationProvider implements NotificationProvider { send(msg) { ... } }
// no other providers exist; the interface adds friction with no benefit
```
**Why it's a smell:** Wrong abstraction is more expensive than no abstraction; calcifies a guess into the codebase; second implementation almost always reveals the interface was shaped wrong.
**Fix:** Inline. Wait for the second concrete case before extracting the abstraction; the shape will be obvious then.
**Review prompt one-liner:** Any new interface / abstract class / config flag — is there a *current* second implementation/caller? If not, inline.

### Comments-as-Explanation (smell, not always)
**Detection signal:** comment exists to explain WHAT the code does (vs WHY); comment that paraphrases the next line; comment that would be unnecessary with better naming.
**Bad example:**
```ts
// Loop over users and check if they are admin
for (const u of users) {
  if (u.role === 'admin') { ... }
}
```
**Why it's a smell:** Comments rot; they lie when code changes; they're a deodorant covering bad naming.
**Fix:** Rename to express intent (`const admins = users.filter(isAdmin)`). Keep comments only for WHY (non-obvious constraint, hidden invariant, workaround for upstream bug — those *must* stay).
**Review prompt one-liner:** Any comment that paraphrases the next line — propose a rename that makes the comment redundant. Keep comments only when they explain WHY.

---

## Couplers

### Feature Envy
**Detection signal:** method in class A reaches into class B's data far more than its own (`order.customer.address.city.normalize()`); method that takes class B as parameter and calls many of B's getters then does logic on results.
**Bad example:**
```ts
class Receipt {
  total(order: Order) {
    return order.items.reduce((s, i) => s + i.price * i.qty * (1 - i.discount), 0)
         + order.shipping
         + order.taxRate * order.subtotal;
  }
}
```
**Why it's a smell:** Logic is on the wrong class; changes to `Order` ripple into `Receipt`; weak encapsulation.
**Fix:** Move Method to the class that owns the data (`order.totalIncludingShippingAndTax()`).
**Review prompt one-liner:** Any method that uses another class's fields more than its own — propose moving it.

### Inappropriate Intimacy
**Detection signal:** two classes know each other's privates (mutual field access, friend-like back-references, bidirectional pointers); test setup requires building both even when testing one.
**Bad example:**
```ts
class Order { customer: Customer; }
class Customer { orders: Order[]; }
// Either side mutates the other's collection directly
```
**Why it's a smell:** Cyclic dependency, fragile tests, refactoring either side breaks both.
**Fix:** Move methods to break the cycle (use a service to mediate); make one side own the relationship and provide a read-only view.
**Review prompt one-liner:** Two classes with bidirectional refs and mutual mutation — propose a mediator or one-way ownership.

### Message Chains (Law of Demeter)
**Detection signal:** `a.b().c().d().e()` chains crossing module boundaries; "tell, don't ask" violated.
**Bad example:**
```ts
const city = user.getProfile().getAddress().getLocation().getCity();
```
**Why it's a smell:** Caller depends on the entire intermediate object graph; any of those classes can break the caller; mocking in tests requires a doll inside a doll.
**Fix:** Hide Delegate (`user.getCity()`) or pass the city in instead of the user. Demeter's rule: a method should only call methods of its own object, parameters, locally created objects.
**Review prompt one-liner:** Any chain of > 2 calls across module boundaries — push the chain into the owner.

### Middle Man
**Detection signal:** class whose every method just delegates to another class with no added value; "wrapper around wrapper".
**Bad example:**
```ts
class UserManager {
  getUser(id) { return this.repo.findById(id); }
  saveUser(u) { return this.repo.save(u); }
  deleteUser(id) { return this.repo.delete(id); }
  // ... 15 more pass-throughs
}
```
**Why it's a smell:** Pure overhead — every change to underlying class also changes the middle man; gives the illusion of decoupling while adding maintenance cost.
**Fix:** Remove Middle Man — callers use `repo` directly. Keep the middle layer only if it adds *real* value (caching, validation, observability, cross-cutting policy).
**Review prompt one-liner:** Any class that's > 70% pass-through delegation — justify the value-add or inline it.

---

## Modern additions (not in original Fowler, but worth flagging)

### Flag Argument (Boolean Parameter)
**Detection signal:** function with `boolean` parameter that switches between two code paths inside.
**Bad example:**
```ts
function sendEmail(to: string, body: string, isHtml: boolean) {
  if (isHtml) { ... } else { ... }
}
```
**Why it's a smell:** Caller readability: `sendEmail(x, y, true)` — true *what*? Two functions are masquerading as one; SRP violated.
**Fix:** Split into `sendHtmlEmail()` + `sendTextEmail()`. If the boolean is genuinely a config knob (not a code-path switch), use a typed enum / discriminated union.
**Review prompt one-liner:** Any boolean parameter that branches the function body — split into two functions or use a typed enum.

### Stringly Typed
**Detection signal:** strings used where enum, branded type, or typed union would fit (`status: string` with allowed values "pending"/"shipped"/"cancelled"); magic-string keys in maps.
**Bad example:**
```ts
function transition(orderId: string, action: string) {
  if (action === 'aprove') { ... } // typo, no compile error
}
```
**Why it's a smell:** Type system can't catch typos or invalid values; refactoring is a global search-and-replace; IDE can't autocomplete.
**Fix:** Discriminated union or enum: `type OrderAction = 'approve' | 'reject' | 'refund'`.
**Review prompt one-liner:** Any `string` parameter or field with a known closed set of values — use a literal union or enum.

### Magic Numbers / Strings
**Detection signal:** unnamed constants embedded in logic (`if (retries > 3)`, `setTimeout(fn, 86400000)`); cryptic strings used as keys or sentinels.
**Bad example:**
```ts
if (user.failedLogins > 5) lockAccount(user, 900);
```
**Why it's a smell:** No grep-target, no central knob to change, intent is lost ("why 5? why 900?").
**Fix:** Replace Magic Number with Symbolic Constant: `const MAX_FAILED_LOGINS = 5; const LOCK_DURATION_SECONDS = 15 * 60;`.
**Review prompt one-liner:** Any unnamed numeric or string constant in logic — name it and place it where it can be tuned.

---

## When NOT to flag a smell

- **Leaf code that won't change again** — a 60-line method in a one-time migration script is not worth refactoring.
- **Test fixtures and setup** — pragmatic duplication often beats clever abstraction in tests.
- **Hot-path code with measured performance impact** — readability sometimes loses to perf; flag only if perf isn't measured.
- **Code the PR didn't touch** — smells already on master are out of scope (per super-review's 🟣 pre-existing rule).

## Sources
- [Refactoring.Guru — Code Smells catalog](https://refactoring.guru/refactoring/smells)
- Martin Fowler, *Refactoring: Improving the Design of Existing Code* (2nd ed.)
- Robert Martin, *Clean Code* (Long Method / Long Class thresholds)
