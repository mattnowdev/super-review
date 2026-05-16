# Case 004 — `any` introduced in public API swallows a real downstream bug

## What this case tests

TypeScript reviewer's ability to detect that a public service signature was
widened from a typed discriminated union (`StripeWebhookEvent`) to `any`, and
that a downstream consumer in the same diff now reads `event.data.object.amount`
as a number without narrowing — when in the original typed model `amount` on
`charge.refunded` was `number | null` and on `payment_intent.succeeded` was
`number`. The `any` erases the discriminator, so the math (`amount / 100`) is
no longer type-checked and silently does `null / 100 = 0` at runtime for the
refund branch.

The diff is structured so a reviewer cannot just keyword-grep for `any`:
- the signature change is one token (`StripeWebhookEvent` → `any`)
- the downstream bug is in a different function in the same file
- there is a justifying comment ("support legacy webhook payloads from v1")
  that a shallow reviewer may accept as rationale

## Skill aspects exercised

- **TypeScript L5 reviewer**: recognising that `any` in a public API signature
  is a contract-erasure smell, not a stylistic preference; suggesting `unknown`
  + a zod/io-ts parse, or extending the discriminated union
- **Cross-function reasoning**: must connect the signature change at the top of
  the file to the consumer 20 lines down that now does unchecked property access
- **Scope discipline**: the pre-existing typed helpers (`isChargeRefunded`,
  `formatAmount`) are correct; reviewer must NOT flag them as broken

## Expected severity: 🟡 FIX-BEFORE-MERGE

`any` in a public boundary is bad enough to block merge until fixed, but it is
not a security or data-corruption bug on its own. The reviewer should NOT
escalate to BLOCK. The right fix is `unknown` + runtime validation, or
extending the union — and the reviewer should say so.
