---
description: React 18.3 → 19+ anti-patterns reference loaded by super-review:run when the diff touches React components. Covers useEffect races, hydration mismatches, key prop misuse, React 19 `use()`/`useActionState`, React Compiler interactions, context misuse, event-listener leaks. Patterns linters miss. Load when reviewing client/src/**/*.{jsx,tsx} or detecting react in package.json.
---

# React review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies React components. Linters like `eslint-plugin-react-hooks` catch the obvious cases — what follows is the residue they miss.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness** and **Frontend** reviewer prompts when it detects React in `package.json` or `.tsx`/`.jsx` files in the diff. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: useEffect race condition on async fetch
**Detection signal:** `useEffect` + `async`/`await` + `setState` with no `AbortController` and no `ignored` flag, especially when deps include changing IDs.
**Verbatim bad code:**
```tsx
useEffect(() => {
  (async () => {
    const res = await fetch(`/api/user/${userId}`);
    const data = await res.json();
    setUser(data); // stale write if userId changed mid-flight
  })();
}, [userId]);
```
**Why it's wrong:** Two rapid `userId` changes resolve out of order; the older response overwrites the newer one and the UI shows wrong-user data.
**Fix:** Use an `ignored` flag or `AbortController` in the cleanup:
```tsx
useEffect(() => {
  const ac = new AbortController();
  fetch(`/api/user/${userId}`, { signal: ac.signal })
    .then(r => r.json()).then(setUser).catch(() => {});
  return () => ac.abort();
}, [userId]);
```
**Review prompt one-liner:** For every `useEffect` that awaits then `setState`, does the cleanup abort the in-flight request or guard the write against being stale?

## Anti-pattern: StrictMode double-fetch masking a real bug
**Detection signal:** Effects whose side effect is non-idempotent (POST, increment counter, append to list, paid API call) — duplicated in dev appears as "StrictMode is annoying" not as "my effect is wrong."
**Verbatim bad code:**
```tsx
useEffect(() => {
  fetch('/api/seat/reserve', { method: 'POST', body: JSON.stringify({ seatId }) });
}, [seatId]);
```
**Why it's wrong:** StrictMode mounts/unmounts twice in dev; if your effect double-firing produces double seats / double charges / duplicate analytics, prod will still hit this on remount or re-mounted Suspense subtrees.
**Fix:** Make the effect idempotent (server-side dedupe key) or move the mutation out of an effect into an event handler / Server Action.
**Review prompt one-liner:** Does this effect's body produce a different observable result if called twice in a row — and if so, why is it in an effect instead of an event handler?

## Anti-pattern: Stale closure in long-lived subscription
**Detection signal:** `useEffect(() => { socket.on('msg', cb) }, [])` where `cb` reads state/props but deps are `[]`; or `setInterval` reading a state variable with empty deps.
**Verbatim bad code:**
```tsx
useEffect(() => {
  const id = setInterval(() => {
    setLog(prev => [...prev, count]); // count is forever 0
  }, 1000);
  return () => clearInterval(id);
}, []);
```
**Why it's wrong:** `count` is captured from the first render. Linter often misses it because the closure happens through `prev`.
**Fix:** Read live state via ref (`countRef.current`) or include the dep and re-create the interval. Use `useEffectEvent` (React 19 stable) for handlers that need fresh values without re-subscribing.
**Review prompt one-liner:** Does this long-lived callback read any non-state-setter value from the render scope, and is that value actually in the dependency array?

## Anti-pattern: Array index as key for reorderable / filterable list
**Detection signal:** `.map((item, i) => <Row key={i} />)` where the array is sorted, filtered, paginated, or has inline-editable inputs.
**Verbatim bad code:**
```tsx
{rows.filter(r => r.visible).map((r, i) => (
  <input key={i} defaultValue={r.name} />
))}
```
**Why it's wrong:** When `visible` flips, React reuses inputs by position; user-typed values bleed into wrong rows because component state stays bound to index `i`.
**Fix:** Use a stable domain ID (`key={r.id}`). For `<></>` in maps, use `<Fragment key={r.id}>` — shorthand fragments cannot take a key.
**Review prompt one-liner:** Is the key derived from a stable identity of the item, and would the key remain unique after filter/sort/insert at head?

## Anti-pattern: Hydration mismatch from `typeof window`, `Date.now()`, locale formatting
**Detection signal:** Render-phase reads of `window`, `navigator`, `localStorage`, `Date.now()`, `Math.random()`, `new Date().toLocaleString()`, `Intl.DateTimeFormat()` without `suppressHydrationWarning` or client-only gating.
**Verbatim bad code:**
```tsx
export default function Price({ amount }: { amount: number }) {
  return <span>{new Intl.NumberFormat().format(amount)}</span>;
  // Server uses 'en-US', client uses navigator.language → mismatch
}
```
**Why it's wrong:** Server's `Intl` default locale ≠ user's browser locale, producing different text and a hydration error that React 19 reports more aggressively.
**Fix:** Pass an explicit locale resolved from `Accept-Language` server-side, or render the formatted output in `useEffect`/`useSyncExternalStore` with a stable server fallback.
**Review prompt one-liner:** Does any render-phase expression depend on time, randomness, locale, time zone, or the existence of `window`?

## Anti-pattern: Controlled input flipping to uncontrolled
**Detection signal:** `value={state?.name}` or `value={data?.x ?? undefined}` — initial render before fetch returns `undefined`, then a string.
**Verbatim bad code:**
```tsx
const [user, setUser] = useState<User>();
return <input value={user?.name} onChange={e => setUser({ ...user!, name: e.target.value })} />;
```
**Why it's wrong:** `value={undefined}` makes the input uncontrolled for that render; React warns and the next defined value silently wipes whatever the user typed in between.
**Fix:** Coerce to empty string: `value={user?.name ?? ''}`. Never mix `defaultValue` and `value` on the same input.
**Review prompt one-liner:** Can `value` ever be `undefined` between renders for any controlled `<input/select/textarea>`?

## Anti-pattern: `use()` hook without a Suspense boundary or error boundary
**Detection signal:** `use(somePromise)` or `use(someContext)` in a client component, where the nearest ancestor is the page root.
**Verbatim bad code:**
```tsx
'use client';
import { use } from 'react';
export function Profile({ p }: { p: Promise<User> }) {
  const user = use(p); // no <Suspense> above → suspends the whole route
  return <h1>{user.name}</h1>;
}
```
**Why it's wrong:** `use()` suspends the component; without a `<Suspense fallback>` ancestor the whole route falls back to the parent's loading boundary or the page goes blank. Without an `ErrorBoundary`, a rejected promise crashes the route — `use()` cannot be wrapped in `try/catch`.
**Fix:** Add both a `<Suspense>` and an `<ErrorBoundary>` immediately around the consumer; create the promise in a Server Component so it's stable across re-renders.
**Review prompt one-liner:** For every `use(promise)`, is there a Suspense and an error boundary directly above it, and is the promise created in a Server Component (not in the client render)?

## Anti-pattern: `useActionState` dispatched outside a transition
**Detection signal:** `const [, dispatch] = useActionState(...)` called from `onClick` directly, not inside a `<form action={dispatch}>` and not wrapped in `startTransition`.
**Verbatim bad code:**
```tsx
const [state, submit] = useActionState(saveAction, null);
return <button onClick={() => submit(payload)}>Save</button>;
```
**Why it's wrong:** Per react.dev/reference/react/useActionState, `dispatchAction` must run inside a transition; calling it directly throws "An async function with useActionState was called outside of a transition." It works in a `<form action={...}>` because React auto-wraps form submission.
**Fix:** `startTransition(() => submit(payload))` or move it to `<form action={submit}>`.
**Review prompt one-liner:** Is every call to a `useActionState` dispatcher either inside `<form action>`, `<button formAction>`, or wrapped in `startTransition`?

## Anti-pattern: Manual `useMemo`/`useCallback` left in place when React Compiler is on
**Detection signal:** `next.config` has `experimental.reactCompiler: true` (or `babel-plugin-react-compiler` configured), yet code is dense with `useMemo`/`useCallback` wrapping primitives or cheap computations.
**Verbatim bad code:**
```tsx
const total = useMemo(() => price * qty, [price, qty]);
const onClick = useCallback(() => setOpen(true), []);
```
**Why it's wrong:** Compiler auto-memoizes; manual memoization adds bookkeeping cost, dependency-array bugs, and confuses readers about which value is referentially stable. Worse, a manual `useMemo` with a wrong deps array overrides what the compiler would have done correctly.
**Fix:** Drop the wrappers in compiler-enabled code; keep them only when you need a referential identity that survives the compiler's reactive scopes (rare — e.g., as an external library key).
**Review prompt one-liner:** Is React Compiler enabled for this file, and if so, does each remaining `useMemo`/`useCallback` have a stated reason beyond "perf"?

## Anti-pattern: Context as service locator for high-frequency state
**Detection signal:** A single `AppContext` provider holding `{ user, theme, cart, modalState, formDraft }` with `useState` in a top-level layout.
**Verbatim bad code:**
```tsx
<AppContext.Provider value={{ user, theme, cart, draft, setDraft }}>
  <App />
</AppContext.Provider>
```
**Why it's wrong:** Every keystroke that updates `draft` re-renders every consumer of the context, regardless of whether they read `draft`. Compiler doesn't fix this — context propagation isn't memoization.
**Fix:** Split by update frequency (separate `DraftContext`); for cross-cutting reactive state, use `useSyncExternalStore`/Zustand/Jotai. Keep React Context for "rarely changes" identity values.
**Review prompt one-liner:** Does any value in this context object change on user input, scroll, or interval — and how many components subscribe to the whole context?

## Anti-pattern: External subscription `addEventListener` without removeEventListener-by-identity
**Detection signal:** `useEffect(() => { window.addEventListener('resize', () => handle()) }, [])` — inline arrow inside `addEventListener` makes the return cleanup impossible.
**Verbatim bad code:**
```tsx
useEffect(() => {
  window.addEventListener('resize', () => setW(window.innerWidth));
  return () => window.removeEventListener('resize', () => setW(window.innerWidth));
}, []);
```
**Why it's wrong:** The two arrow functions are different references; `removeEventListener` removes nothing; listener leaks on every remount.
**Fix:** Hoist the handler to a named const within the effect and pass it to both add/remove. Better: `useSyncExternalStore` for window/media-query subscriptions.
**Review prompt one-liner:** Does every `addEventListener` cleanup pass the same function reference (not an inline arrow) to `removeEventListener`?

## What good looks like

### Effect with abort + cleanup
```tsx
useEffect(() => {
  const ac = new AbortController();
  fetch(url, { signal: ac.signal })
    .then(r => r.json())
    .then(d => setData(d))
    .catch(e => { if (e.name !== 'AbortError') reportError(e); });
  return () => ac.abort();
}, [url]);
```
**Why it works:** Abort propagates on dep change + unmount; AbortError silently dropped; no stale write race.
**Affirm:** Every async effect ties an `AbortController` to cleanup.

### Server-content composition via `children` prop
```tsx
// ServerLayout.tsx (no 'use client')
<InteractiveShell>
  <ExpensiveServerTree />   {/* stays on server */}
</InteractiveShell>
```
**Why it works:** `'use client'` boundary stays at the shell; child tree renders on the server and is passed in as already-rendered children. Bundle stays small.
**Affirm:** Client components receive server content via `children` prop, not by importing server modules.

### External subscription via `useSyncExternalStore`
```tsx
const width = useSyncExternalStore(
  cb => { window.addEventListener('resize', cb); return () => window.removeEventListener('resize', cb); },
  () => window.innerWidth,
  () => 1024 // SSR snapshot
);
```
**Why it works:** Concurrent-mode safe; correct tearing semantics; clean cleanup; same-reference handler.
**Affirm:** Browser-API subscriptions (window, media query, network status) use `useSyncExternalStore`, not raw `useEffect` + `addEventListener`.

### Discriminated union for component state machine
```tsx
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User }
  | { status: 'error'; error: Error };

if (state.status === 'success') return <Profile user={state.data} />; // TS narrows
```
**Why it works:** Impossible states cannot be represented; exhaustive `switch` proven by compiler with `assertNever`.
**Affirm:** Component state with multiple modes is modeled as a discriminated union, not separate booleans (`isLoading`, `isError`, `hasData`).

## Sources
- [react.dev — use() hook](https://react.dev/reference/react/use)
- [react.dev — useActionState](https://react.dev/reference/react/useActionState)
- [react.dev — useEffectEvent](https://react.dev/reference/react/useEffectEvent)
- [react.dev — useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
