# Case 005 — useEffect fetch race when id prop changes mid-flight

## What this case tests

React reviewer's ability to detect a classic stale-write race introduced when a new `useEffect` fetches data keyed on a prop (`userId`) without an `AbortController` (or `ignore` flag) cleanup. When the prop changes faster than the network round-trip, the older in-flight response can resolve *after* the newer one and overwrite state with stale data — the UI then shows the wrong user's profile.

The PR adds a useEffect with `[userId]` dependency that:
1. Calls `fetch("/api/user/${userId}")`
2. Awaits `res.json()`
3. Calls `setUser(...)`

…with no cleanup function. This is the textbook bug in every React docs page about effects ("You Might Not Need an Effect" / "Synchronizing with Effects").

## Skill aspects exercised

- **React L5 reviewer**: recognize the missing cleanup pattern on prop-keyed fetch effects
- **User-impact reasoning**: race condition must be framed as user-visible "shows wrong user's data" not just theoretical
- **Scope discipline**: the component does NOT render a list — reviewer must NOT hallucinate a "missing `key` prop" finding. There is also no security concern here (no auth bypass, no XSS, no token leak) — reviewer must NOT escalate to cybersec.

## Expected severity: 🟠 FIX-BEFORE-MERGE

Stale writes here cause cross-user data display (User A's profile shown while viewing User B). Not a security boundary breach (the fetched data is whatever the backend authorized for the *current* user's session), but a correctness bug that ships visibly wrong UI to end users. Must be fixed before merge — either add `AbortController` + `signal` cleanup, or use an `ignore` boolean in the cleanup closure.
