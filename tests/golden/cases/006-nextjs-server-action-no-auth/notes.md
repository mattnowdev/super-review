# Case 006 — Next.js `'use server'` Server Action mutates DB without auth check

## What this case tests

The Next.js + Cybersec reviewers' ability to detect that a newly-added Server Action exported from a `'use server'` module is a **publicly callable HTTP endpoint**, not a private function. Any function exported from a `'use server'` file becomes addressable over the network by its server-generated action ID — and Next.js exposes that ID in the client bundle the moment any client component imports the action. Even if no client imports it yet, the convention is that Server Actions are reachable via POST and the action ID surface must be treated as public input.

In this diff, `deletePost(formData)` calls `db.post.delete({ where: { id: formData.get('id') } })` with:

1. **No `auth()` / `getSession()` check at the top of the body** — anyone with the action ID can invoke
2. **No authorization check** — even an authenticated user can delete *any* post, not just their own (BOLA / IDOR)
3. **No Zod / input validation** — `formData.get('id')` is `FormDataEntryValue | null`, passed straight to Prisma

Unguessable ≠ authorized. Action IDs leak via:
- Any client component that imports the action (bundled into JS)
- React Server Component payloads (visible in Network tab)
- Build artifacts and source maps

## Skill aspects exercised

- **`super-review:nextjs`** anti-pattern: Server Action treated as private function instead of public POST endpoint; missing `'server-only'` import on the helper boundary; no auth gate at top of action body
- **`super-review:cybersec`** anti-pattern: Broken Object-Level Authorization (OWASP A01:2021, CWE-862 Missing Authorization, CWE-639 Authorization Bypass Through User-Controlled Key)
- **Scope discipline**: reviewer must NOT flag the unchanged `app/posts/page.tsx` (no diff there) — only the new `actions.ts` file
- **Severity discipline**: this is BLOCK, not FIX-FOLLOWUP. A drive-by attacker can drop the entire `Post` table with `curl` once they obtain or brute-discover the action ID. No demotion acceptable.

## Expected severity: 🔴 BLOCK

This is the **#1 Next.js production bug class in 2025–2026**. The Server Action security model is poorly understood by application developers — the `'use server'` directive looks like `'use client'`'s twin, but `'use client'` is a *bundling* hint while `'use server'` is an *RPC export*. Multiple postmortems in 2025 (Vercel's own security advisories, the Sanity.io disclosure, the Builder.io research) traced data-deletion incidents to exactly this pattern: a Server Action that authors believed was "internal to the page" because only one Server Component called it.

The fix is non-negotiable: every Server Action body must start with an `auth()` check and an ownership check before touching the DB. Zod validation is also required but is a separate (FIX-BEFORE-MERGE) concern — the BLOCK is on authz.

## Why this is a good test

- **Mental model trap**: a reviewer that treats `'use server'` like a private function (analogous to a server-only helper) will miss the bug entirely. Correct review requires recognizing the action as a public HTTP POST endpoint.
- **Multi-skill convergence**: `nextjs` skill catches the framework anti-pattern; `cybersec` catches the OWASP/CWE classification. Both should fire on the same lines without double-counting the same finding as separate must_finds (reviewer aggregation behavior).
- **Tolerance window**: a FIX-BEFORE-MERGE finding about missing Zod validation on `formData.get('id')` is an acceptable adjacent finding — it's a real bug, just not the BLOCK-class one. This validates the reviewer can distinguish severity tiers rather than collapsing everything to BLOCK or everything to FIX.
