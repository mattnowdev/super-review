# Case 002 — Network I/O inside a Prisma `$transaction`

## What this case tests

Postgres + ORM reviewers' ability to detect `await stripe.charges.create(...)` (a network call) inside a `prisma.$transaction` callback. The transaction holds row locks + advances the xmin horizon for the duration of the HTTP roundtrip — one slow Stripe response pins vacuum and bloats hot tables.

## Skill aspects exercised

- **`super-review:postgres`** anti-pattern: `idle in transaction` from awaiting external I/O inside BEGIN
- **`super-review:orm`** anti-pattern: Prisma `$transaction` callback that captures the outer client (this case has BOTH — adding network I/O AND using the outer `prisma` client inside the tx)
- **Severity calibration**: this is FIX-FOLLOWUP (perf/stability, not data-integrity), NOT BLOCK. Reviewer must distinguish.

## Expected severity: 🟡 FIX-FOLLOWUP

Slow upstream pins vacuum + exhausts pool under load. Correctness-wise the DB writes are atomic with each other (the Stripe call is a side effect that survives rollback either way), so this is a stability/perf issue, not data integrity.

## Why this is a good test

Two distinct anti-patterns in one 6-line diff. A scope-disciplined reviewer flags both as a single composite finding (or two adjacent followups), not as four separate things.
