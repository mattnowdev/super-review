---
description: Self-audit sub-skill for super-review. Reads past super-review comments on a PR (or across multiple PRs in a repo) and audits the audits — surfaces repeated false positives, missed-positive patterns, and proposes concrete skill-prompt edits. Use when the user says "audit super-review", "review the reviews", "what's super-review getting wrong", "/super-review:audit-self", or wants to tune the skill against this team's actual usage history.
---

# super-review:audit-self

A meta-skill that reviews super-review's own output history and proposes improvements. Run periodically (monthly / quarterly / after the skill catches an embarrassing miss) to keep the skill calibrated to your team's reality.

## When to invoke

- After a finding was clearly wrong and the team rolled their eyes
- After a real bug shipped that super-review should have caught but didn't
- Quarterly hygiene — drift check against your repo's evolving stack + conventions
- Before bumping super-review to a new major version (regression check)

## What it does

1. **Gather**: pull super-review comments from the last N PRs in this repo via `gh api`. Read `.claude/super-review/<repo>/history.jsonl` if cross-PR memory is enabled.

2. **Classify each finding**:
   - **Confirmed by merge** — the PR addressed the finding before merge
   - **Dismissed by author** — author replied disputing the finding (capture the reason if available)
   - **Quietly ignored** — finding posted, PR merged unchanged, no reply
   - **Outdated after merge** — finding flagged something a subsequent PR proved was fine

3. **Pattern-mine** the classifications. Group by `(sub-skill, anti-pattern slug)`:
   - **High-FP patterns** — > 30% dismissal rate AND > 3 occurrences. These need either stricter detection signals (require more context before flagging) or a `severityOverrides` entry in `.super-review.json` to demote them.
   - **High-confirm patterns** — > 80% addressed before merge. These are working well; keep.
   - **Quietly-ignored patterns** — high incidence, low engagement. Either the team disagrees but doesn't push back, or the finding doesn't make the case clearly enough.
   - **Missed-bug patterns** — incidents that super-review should have caught (requires external signal: bug report, postmortem, hotfix PR).

4. **Cross-check against the corpus**: for each high-FP pattern, search recent PRs for cases where this pattern fired AND the team merged anyway. Verify the FP classification is correct (i.e. the author had a real reason, not just "I disagree").

5. **Propose edits**:
   - Concrete `.super-review.json` config recommendations (allow-list entries, severity overrides, disabled patterns) for the project owner to adopt
   - Concrete SKILL.md prompt edits for the relevant sub-skill (refined detection signal, tighter "when NOT to flag" section, added context requirement)
   - New `redFlagAddons` entries if the audit surfaced repeating real bugs the skill doesn't yet name

## Output format

```markdown
# super-review self-audit — <repo> (PRs <N1>–<N2>)

**Findings reviewed:** N
**Classification rates:**
- Confirmed: X%
- Dismissed: Y% (target: < 15%)
- Quietly ignored: Z%
- Missed real bugs (from external signal): K incidents

## High-FP patterns (recommend demote or allow-list)
- `crypto:math-random-tokens` — 8 occurrences, 6 dismissals (75% FP). Inspection: all dismissals were in test fixtures. → Proposed config: allow-list `crypto:math-random-tokens` for `**/*.test.*` and `**/fixtures/**`.

## High-confirm patterns (working well)
- `nextjs:server-action-missing-auth` — 4 occurrences, 4 addressed before merge. Keep.

## Missed-bug patterns (skill should improve)
- Bug report 2026-04-15: "share-link tokens visible in our Datadog logs". super-review did not flag at PR-time. Root cause: `web-headers:onRequest-logs-raw-url` pattern didn't exist in v1.0; added in v1.1. ✅ Already addressed.
- Bug report 2026-05-02: "concurrent share-link accepts double-charged inventory". super-review's `postgres:lost-update` flagged the underlying RMW but tagged as FIX-FOLLOWUP, not BLOCK. → Proposed override: in this repo, lost-update on inventory tables = BLOCK.

## Quietly-ignored patterns (review for prompt clarity)
- `design:speculative-generality` — 12 occurrences, 0 replies, all merged. Either the team disagrees with the YAGNI framing or the finding bodies don't make the cost clear. Recommend tightening the "Why it's wrong" to cite concrete maintenance scenarios from this repo's history.

## Proposed `.super-review.json` patch
\`\`\`json
{
  "patternAllowlist": [
    { "skill": "crypto", "pattern": "math-random-tokens", "paths": ["**/*.test.*", "**/fixtures/**"], "reason": "All FPs in tests; production paths use crypto.randomBytes."}
  ],
  "severityOverrides": {
    "postgres:lost-update-on-inventory": "BLOCK"
  }
}
\`\`\`
```

## What this sub-skill is NOT

- Not for tuning the *universal* skill on Mat's behalf — it tunes super-review to one specific repo's history.
- Not a substitute for the golden-PR test harness, which catches *prompt regressions* on a fixed corpus. This sub-skill catches *fit-with-this-team* over time.
- Not auto-applied. It proposes config patches; humans review and merge.

## Triggers

- `/super-review:audit-self <repo>` or `/super-review:audit-self` (current repo)
- "audit super-review", "review the reviews", "what's super-review getting wrong"
