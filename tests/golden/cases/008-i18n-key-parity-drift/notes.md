# Case 008 — i18n key parity drift across locale files

## What this case tests

The `super-review:i18n` reviewer's ability to spot the single most common multi-locale bug: a translation key added to one locale file (`pl.json`) but forgotten in its siblings (`en.json`, `de.json`). The new key `share.modal.bookClubMode` is wired into a React component via `t('share.modal.bookClubMode')` and added to Polish, but English and German users will render either the raw key (`share.modal.bookClubMode`) or — depending on the i18n library's fallback policy — the Polish string in an English/German UI. Both outcomes are visible, embarrassing regressions that ship the moment the PR merges.

Derived from a recurring Vellam pattern: Polish is the source locale (product is PL-first), copy lands there first, and the German/English mirrors drift behind by days or weeks. The bug is usually caught by users, not by CI.

## Skill aspects exercised

- **i18n reviewer**: cross-file key-set diff between sibling locale JSON files
- **Cross-file reasoning**: must connect `t('share.modal.bookClubMode')` usage in `ShareModal.tsx` with the absence of that key in `en.json` and `de.json` even though it was added to `pl.json`
- **Scope discipline**: the component change (`<input>` row using the new key) is correct in isolation — reviewer must NOT flag the component as the bug; the bug is in the locale files
- **No security escalation**: this is a UX/correctness regression, not data loss or auth bypass — must not escalate to BLOCK

## Expected severity: 🟠 FIX-BEFORE-MERGE

User-visible string regression in two of three supported locales. Not a security or data-integrity bug, so not BLOCK. But shipping with raw `share.modal.bookClubMode` rendered in the German and English UIs is unacceptable for a paid product — must be fixed before merge, not deferred to a follow-up.

## Why CI should eventually catch this (but doesn't today)

The correct long-term fix is a CI parity check: a script that diffs the key sets across all locale files and fails the build on drift. Tools like `i18next-parser`, `lokalise`, or a 20-line `jq` script in CI all solve this. Until that's wired, the human (or AI) reviewer is the only line of defense — which is exactly what this golden case validates.

A reviewer surfacing a `FIX-FOLLOWUP` or `NIT` recommending the CI parity check alongside the main finding is welcome (and counted in tolerance), but the missing-key finding itself must be the primary `FIX-BEFORE-MERGE`.
