---
description: Test-code anti-patterns reference loaded by super-review:run when the diff touches test files or ships production logic without tests. Covers structural-mock-only assertions, snapshot-as-only-assertion, time/random in test bodies, brittle selectors, shared mutable state, async races, missing negative cases, AAA violations, mocks that diverge from real behavior, multi-concern tests, coverage games, test-infra changes that mask failures, flaky patterns. Load when test files in diff (`*.test.*`, `*.spec.*`, `__tests__/`) OR significant production code changes without corresponding tests added.
---

# Testing review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies or adds tests — or when production logic changed with no tests added. This file is about **reviewing tests already written**, not deciding whether more tests are needed. Coverage tools and linters catch line counts; what follows is the residue they miss: tests that pass while the code is broken, tests that fail for reasons unrelated to the code, and tests that quietly stop testing anything at all.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness** and **Test-Quality** reviewer prompts when it detects `*.test.*`, `*.spec.*`, or `__tests__/` paths in the diff, or when significant production changes ship without test deltas. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: Structural-mock-only test (asserts call counts, not behavior)
**Detection signal:** `expect(mock).toHaveBeenCalledWith(...)` is the *only* assertion; no check on return value, observable state, or rendered output.
**Verbatim bad code:**
```ts
it('saves user', async () => {
  const repo = { save: vi.fn() };
  await createUser(repo, { name: 'Mat' });
  expect(repo.save).toHaveBeenCalledWith({ name: 'Mat' });
});
```
**Why it's wrong:** Test passes if `createUser` calls `repo.save` with the right arg — even if it then throws, returns garbage, or never persists. You've tested that the production code calls the function you told it to call. That's a tautology, not a test.
**Fix:** Assert on the observable outcome: returned value, repo state after the call, emitted event, or HTTP response. Mock-call assertions are an *addition* to behavior assertions, not a replacement.
**Review prompt one-liner:** Does this test assert any observable outcome (return value, state, output) beyond `mock.toHaveBeenCalledWith`?

## Anti-pattern: Snapshot as the only assertion on new logic
**Detection signal:** New function/component ships with `expect(result).toMatchSnapshot()` and no other assertion; first-run snapshot is the "spec."
**Verbatim bad code:**
```tsx
it('renders pricing card', () => {
  const { container } = render(<PricingCard plan="pro" />);
  expect(container).toMatchSnapshot();
});
```
**Why it's wrong:** The snapshot file is generated *from the implementation*, so the test asserts "the code produces what the code produced." Any bug in the first run is locked in as the contract. Future regressions get rubber-stamped with `--update-snapshots` because nobody reads diffs.
**Fix:** Use explicit assertions for the contract (`expect(screen.getByText('$49/mo')).toBeVisible()`); use snapshots only as a *secondary* guard on shapes that are hard to enumerate, never on new behavior.
**Review prompt one-liner:** Is there any non-snapshot assertion that would fail if the snapshot were wrong from day one?

## Anti-pattern: `Date.now()` / `Math.random()` / real `setTimeout` in test body
**Detection signal:** Test reads `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, or awaits a real `setTimeout` / `setInterval` without `vi.useFakeTimers()` / `jest.useFakeTimers()`.
**Verbatim bad code:**
```ts
it('expires token after 1h', async () => {
  const token = issueToken();
  await new Promise(r => setTimeout(r, 3_600_000)); // hangs CI for an hour
  expect(isValid(token)).toBe(false);
});
```
**Why it's wrong:** Real time makes tests slow *and* flaky — CI under load misses the window, DST flips alter durations, midnight crossings change date math. Real randomness means a failure on one run is unreproducible on the next.
**Fix:** `vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); ...; vi.advanceTimersByTime(3_600_001);`. For randomness, inject a seeded RNG or stub the source.
**Review prompt one-liner:** Does any time- or randomness-dependent assertion run against the real wall clock or real RNG?

## Anti-pattern: Brittle selectors (translated text, hashed class names)
**Detection signal:** `getByText('Zapisz')` (locale-dependent), `container.querySelector('.Button_primary__a8Df2')` (bundler-hashed), or XPath into deep DOM by index.
**Verbatim bad code:**
```ts
const btn = container.querySelector('.Button_primary__a8Df2');
expect(btn?.textContent).toBe('Zapisz zmiany');
```
**Why it's wrong:** Hashed CSS-module class names change every build; translated strings break the test the moment marketing edits copy or a new locale ships. The test fails for reasons unrelated to the behavior it claims to cover.
**Fix:** Use semantic queries (`getByRole('button', { name: /save/i })`), `data-testid`, or message-key lookups (`getByText(t('actions.save'))`). For visual styling, assert computed style or aria attribute, not class string.
**Review prompt one-liner:** Would this selector break if a translator changed wording or a bundler regenerated class hashes?

## Anti-pattern: Shared mutable state across tests
**Detection signal:** Module-scope `let` variables mutated by tests, `beforeAll` that seeds without matching `afterAll` cleanup, singletons modified inside `it` blocks.
**Verbatim bad code:**
```ts
let cache: Map<string, User> = new Map();
beforeAll(() => { cache.set('u1', { name: 'Mat' }); });
it('reads cached user', () => { expect(cache.get('u1')?.name).toBe('Mat'); });
it('deletes user', () => { cache.delete('u1'); expect(cache.size).toBe(0); });
// Run order swap → first test now fails.
```
**Why it's wrong:** Test order becomes load-bearing. Parallel runners (vitest threads, jest workers) re-order silently. A green local run becomes red CI run with no code change. Worse: passing tests start asserting on state left behind by *other* tests.
**Fix:** Construct state fresh in `beforeEach`; use `afterEach` to tear down. Treat each `it` as if it's the only test that will ever run.
**Review prompt one-liner:** If this test ran alone, or last instead of first, would it still pass?

## Anti-pattern: Async race — missing `await`, fire-and-forget assertion
**Detection signal:** Async test function with un-awaited promise calls; `expect(...)` placed *before* the awaited side-effect completes; `.then(expect(...))` without returning the chain.
**Verbatim bad code:**
```ts
it('updates user', async () => {
  updateUser('u1', { name: 'New' }); // missing await
  const u = await getUser('u1');
  expect(u.name).toBe('New'); // races; sometimes passes, sometimes 'Old'
});
```
**Why it's wrong:** Test passes when the race happens to win, fails intermittently otherwise — classified as "flaky" and retried into the green by CI policy. The bug it's masking is real.
**Fix:** `await` every promise. Enable `eslint-plugin-vitest`/`jest`'s `no-floating-promises` and `no-standalone-expect`. For event-driven code, use `await waitFor(() => expect(...).toBe(...))`.
**Review prompt one-liner:** Is every promise in this test awaited or explicitly returned, and is every assertion placed *after* the awaited completion?

## Anti-pattern: Happy-path only — no negative-case coverage
**Detection signal:** New endpoint/function has tests for the success branch; no test for auth-denied, role-denied, validation-failure, 4xx response, malformed input, missing required field.
**Verbatim bad code:**
```ts
describe('POST /admin/delete-user', () => {
  it('deletes user', async () => {
    const res = await request(app).post('/admin/delete-user').send({ id: 'u1' });
    expect(res.status).toBe(200);
  });
  // No test for: unauthenticated, non-admin role, missing id, non-existent id.
});
```
**Why it's wrong:** Most production bugs live in error paths and authorization checks. A `200`-only test suite ships a `/admin/delete-user` that anyone can call. The diff looks well-tested by line count.
**Fix:** For every happy-path test, pair it with at least one denial test (auth, role, validation, not-found). Make this a checklist item, not a judgement call.
**Review prompt one-liner:** For each new branch in production code, does at least one test cover the denial/failure path, not only the success path?

## Anti-pattern: AAA broken — multiple acts in one `it`
**Detection signal:** A single `it` block performs setup → action → assert → another action → assert → another action; assertions interleaved with mutations.
**Verbatim bad code:**
```ts
it('user lifecycle', async () => {
  const u = await createUser({ name: 'Mat' });
  expect(u.id).toBeTruthy();
  await updateUser(u.id, { name: 'Mateusz' });
  expect((await getUser(u.id)).name).toBe('Mateusz');
  await deleteUser(u.id);
  expect(await getUser(u.id)).toBeNull();
});
```
**Why it's wrong:** When the test fails, you don't know which step broke without re-reading. Failures cascade — a broken `updateUser` makes the delete assertion fail too, doubling the apparent surface area. CI output reports one failure when three things are wrong.
**Fix:** One `it` = one Arrange, one Act, one (cluster of related) Assert. Use a `describe` block to share setup across the three lifecycle tests via `beforeEach`.
**Review prompt one-liner:** Does this `it` block contain exactly one logical action being verified?

## Anti-pattern: Mocks that don't match real behavior (signature drift)
**Detection signal:** Mock returns a sync value when production code's real dependency is async; mock returns a plain object where real returns a class instance with methods; mock throws a `string` where real throws a typed `Error`.
**Verbatim bad code:**
```ts
vi.mock('./db', () => ({
  findUser: vi.fn(() => ({ id: 'u1', name: 'Mat' })), // real findUser returns Promise<User>
}));
it('reads user', async () => {
  const u = await findUser('u1'); // awaiting a sync value resolves to the value
  expect(u.name).toBe('Mat'); // green
});
```
**Why it's wrong:** The test passes in mock-land because `await syncValue === syncValue`. In prod the real async returns a Promise that callers might forget to await; the bug ships green. Same story for missing methods, wrong error classes, undefined fields.
**Fix:** Mocks must satisfy the real type signature — `findUser: vi.fn(async () => ({...}))`. Use `vi.mocked()` with the real import for type-checking; consider contract tests that exercise the real dep periodically.
**Review prompt one-liner:** Does each mock return the same shape and async-ness as the real implementation it stands in for?

## Anti-pattern: One `it` asserting on N independent concerns
**Detection signal:** A single `it('does X')` containing 5+ `expect()` calls on unrelated properties (e.g., response status, header, body field, db state, emitted event, log line).
**Verbatim bad code:**
```ts
it('works', async () => {
  const res = await api.post('/users', { name: 'Mat' });
  expect(res.status).toBe(201);
  expect(res.headers['x-request-id']).toBeDefined();
  expect(res.body.id).toMatch(/^u_/);
  expect(await db.users.count()).toBe(1);
  expect(emitter.events).toContainEqual({ type: 'user.created' });
  expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/created/));
});
```
**Why it's wrong:** First failing `expect` halts the rest; you fix it, re-run, find the next one, repeat. Test name "works" tells nothing. Coverage of the six concerns looks like one test in reports.
**Fix:** Split into `it('returns 201 with id')`, `it('writes one user row')`, `it('emits user.created')`, `it('logs creation')`. Share setup via `beforeEach`. Use `it.each` for parameterized variants.
**Review prompt one-liner:** Does each `it` test one observable concern, with a name that describes that concern?

## Anti-pattern: Coverage games — assertions that can't fail
**Detection signal:** `expect(true).toBe(true)`, `expect(result).toBeDefined()` on a function that always returns a value, `expect(() => fn()).not.toThrow()` as the only assertion, empty `it` body with just a render.
**Verbatim bad code:**
```ts
it('renders without crashing', () => {
  render(<Dashboard />);
  // no assertion
});
it('returns something', () => {
  expect(getConfig()).toBeDefined();
});
```
**Why it's wrong:** Coverage tools count the lines as covered; the test asserts nothing about correctness. A dev hit a coverage threshold without testing behavior. These tests survive arbitrary refactors that break the feature.
**Fix:** Every `it` must assert at least one *specific* property of the result. "Doesn't crash" is the floor, not the test — pair it with an assertion on rendered content or returned value.
**Review prompt one-liner:** Could this test still pass if the function under test were replaced with `() => 'anything'`?

## Anti-pattern: Test-infra changes that mask failures (`.skip`, broadened mocks, retry loops)
**Detection signal:** Diff adds `.skip` / `xit` to previously-passing tests, broadens a mock from specific to `vi.fn()`, increases retry count, raises timeout, or adds `.toContain` where `.toEqual` used to be — without an issue link explaining why.
**Verbatim bad code:**
```diff
- it('rejects expired token', async () => { ... })
+ it.skip('rejects expired token', async () => { ... })
+
+ retry: 3, // was 0
+ testTimeout: 30_000, // was 5_000
```
**Why it's wrong:** Hides a real regression behind quiet infra knobs. Reviewers skim the test file, see green checkmarks, miss the `.skip`. Retry-into-green converts deterministic failures into "flakes." Broadened mocks accept anything, so the test never fails on signature drift again.
**Fix:** Block `.skip` / `xit` without `// TODO(link-to-issue)`; require commit-message justification for timeout/retry increases. Treat tightening (`toEqual` → `toEqual(exact)`) as positive, loosening as a red flag.
**Review prompt one-liner:** Did this diff `.skip` a test, loosen a matcher, broaden a mock, or raise a retry/timeout — and is the reason documented?

## Anti-pattern: Flaky-by-construction (real network, real DB without isolation, host time zone)
**Detection signal:** Test calls `fetch('https://api.real-service.com/...')`, connects to a shared dev DB, asserts on `toLocaleString()` without explicit locale/timeZone, depends on file-system ordering, on `process.env.TZ` being any specific value.
**Verbatim bad code:**
```ts
it('fetches user from upstream', async () => {
  const u = await fetch('https://api.upstream.dev/users/1').then(r => r.json());
  expect(u.name).toBe('Mat');
});
it('formats date', () => {
  expect(new Date(0).toLocaleString()).toBe('1/1/1970, 1:00:00 AM'); // breaks outside Europe/Warsaw
});
```
**Why it's wrong:** Network call fails on the CI image without internet, fails when upstream is down, fails when upstream rotates data. Locale assertion passes for the author, fails for everyone else. These are not flaky tests — they are correctly-failing tests revealing they were always wrong.
**Fix:** Mock fetch via MSW or `vi.spyOn(global, 'fetch')`. Use ephemeral DBs (testcontainers, pg-mem, in-memory SQLite). Pin locale and time zone: `new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' })`. Set `process.env.TZ = 'UTC'` in test setup.
**Review prompt one-liner:** Does this test require network, a shared DB, a specific host time zone, or a specific locale to pass?

## What good looks like

### AAA discipline with a single act
```ts
it('returns 403 for non-admin caller', async () => {
  // Arrange
  const token = signToken({ role: 'user' });

  // Act
  const res = await request(app)
    .delete('/admin/users/u1')
    .set('authorization', `Bearer ${token}`);

  // Assert
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('forbidden');
});
```
**Why it works:** One arrange, one act, one cluster of assertions on the same response. Test name describes the behavior precisely; failure points at exactly one regression.
**Affirm:** Every `it` has a clear Arrange/Act/Assert separation and a single logical action.

### Real-DB integration test with isolation
```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
beforeAll(async () => { container = await new PostgreSqlContainer().start(); });
afterAll(async () => { await container.stop(); });
beforeEach(async () => { await db.exec('TRUNCATE users CASCADE'); });

it('persists user across query boundary', async () => {
  await repo.create({ id: 'u1', name: 'Mat' });
  const reread = await repo.findById('u1');
  expect(reread).toEqual({ id: 'u1', name: 'Mat' });
});
```
**Why it works:** Exercises the *real* SQL, real driver, real types — catches the bugs in-memory mocks hide (column-name typos, JSON-vs-JSONB, null handling). Per-test truncation isolates state; per-suite container avoids startup cost.
**Affirm:** Repository/query code is tested against a real database, not against an ORM mock.

### Fake timers for time-sensitive behavior
```ts
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-05-15T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

it('expires token after 1h', () => {
  const token = issueToken({ ttlMs: 3_600_000 });
  vi.advanceTimersByTime(3_600_001);
  expect(isValid(token)).toBe(false);
});
```
**Why it works:** Deterministic, instant, time-zone-independent. Same result on every machine, every CI run, every DST flip.
**Affirm:** Time-dependent tests use `vi.useFakeTimers()` / `jest.useFakeTimers()` and pin the system time.

### Test data factories with explicit overrides
```ts
const aUser = (overrides: Partial<User> = {}): User => ({
  id: 'u_default',
  name: 'Default',
  role: 'user',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

it('admin can delete any user', async () => {
  const target = aUser({ id: 'u_target' });
  const caller = aUser({ id: 'u_admin', role: 'admin' });
  // ...
});
```
**Why it works:** Each test states exactly what matters for the case (`role: 'admin'`) and inherits sane defaults for the rest. No shared mutable fixture; no "test 3 broke because test 1 changed `users[0].role`."
**Affirm:** Test data is built via a factory function with explicit per-test overrides, not from shared module-scope fixtures.

### Negative-case parity
```ts
describe('POST /admin/users/:id (DELETE)', () => {
  it('deletes when caller is admin', async () => { /* 200 */ });
  it('returns 401 when no token', async () => { /* 401 */ });
  it('returns 403 when caller is not admin', async () => { /* 403 */ });
  it('returns 404 when target does not exist', async () => { /* 404 */ });
  it('returns 422 when id is malformed', async () => { /* 422 */ });
});
```
**Why it works:** Every branch in the production handler has a corresponding test. A regression that drops the role check fails one specific test with a clear name — no detective work.
**Affirm:** Every happy-path test for a route or function has at least one paired denial/failure test in the same `describe`.

## Sources
- [Kent C. Dodds — Common Testing Mistakes](https://kentcdodds.com/blog/common-testing-mistakes)
- [Testing Library — Guiding Principles](https://testing-library.com/docs/guiding-principles)
- [Martin Fowler — Test Double](https://martinfowler.com/bliki/TestDouble.html)
- [Vitest — Fake Timers](https://vitest.dev/api/vi.html#vi-usefaketimers)
- [Testcontainers for Node.js](https://node.testcontainers.org/)
- [Google Testing Blog — Test Behavior, Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)
