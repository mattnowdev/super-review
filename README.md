# super-review

A multi-agent PR review skill for [Claude Code](https://docs.claude.com/en/docs/claude-code). Covers every angle.

Dispatches **N specialist reviewers in parallel** (cybersecurity, supply-chain, correctness, design / blast-radius, migration, performance, frontend, observability, tests), gates findings through an evidence-quoting false-positive filter, runs cross-reviewer collision + Opus meta-verification, and produces a **bounded, actionable report scoped strictly to the PR diff**.

Tuned for senior reviewers who want signal, not noise.

## Why this skill exists

Off-the-shelf AI PR review fails the same way every time:

- **Noise volume** — flags every "could be problematic" and "consider extracting", drowning real bugs.
- **Hallucinated lines** — cites code that isn't there.
- **Scope creep** — comments on pre-existing bugs the PR merely *touched*, burning reviewer trust.
- **Intent laundering** — reads the commit message and downgrades real security regressions.
- **Verification theatre** — a "verifier" agent that re-reads the same diff without fresh evidence.

This skill is opinionated about each of those failure modes. Findings ship only if **twice-confirmed with quoted code evidence**, and the output is hard-capped (≤3 BLOCK, ≤5 fix-before-merge, ≤5 follow-up, ≤3 nits + overflow summary).

## Architecture

```
Phase 0: SCOPE-LOCK & GROUND      single agent — defines diff bounds + context brief (commit messages stripped to prevent intent laundering)
Phase 1: PARALLEL REVIEW          N path-filtered specialist subagents (single message, parallel dispatch)
Phase 2: FALSE-POSITIVE GATE       fresh agent re-opens each file, byte-matches the quoted code, drops hallucinations
Phase 3: COLLIDE                  cross-reviewer contradictions + negative space + forced contrarian (deep-thinking-partner Stage 3)
Phase 4: OPUS META-VERIFICATION   catches Sonnet compounding-pessimism + missed positives + shared-prior blind spots
Phase 5: SYNTHESIZE & POST         bounded report → GitHub comment + local summary
```

Three modes:

- `Full` (default) — all 5 phases. ~6-12 min on a non-trivial PR.
- `Fast` — Phase 0 → Phase 1 (≤3 reviewers) → Phase 2 → Phase 5. Use for PRs <200 LOC.
- `Security-only` — cybersec + supply-chain reviewers only, full gate. Use when auth/crypto/IAM changes dominate.

## Severity taxonomy

| Tier | Meaning | Blocks merge? |
|---|---|---|
| 🔴 **BLOCK** | Data loss, RCE, auth bypass, broken migration, mass-assignment of identity | Yes |
| 🟠 **FIX-BEFORE-MERGE** | Functional bug introduced, missing test on load-bearing path, broken contract | Yes |
| 🟡 **FIX-FOLLOWUP** | Architecture / perf / observability concerns; file as separate issue | No |
| ⚪ **NIT** | Tiny; capped at 3 (rest summarized) | No |
| 🟣 **PRE-EXISTING** | Bug exists on the base branch; PR exposes but doesn't introduce it | Never |
| ⚠️ **RED FLAG** | Damage beyond the diff — own section at top of report | Surfaces in summary |

The 🟣 **pre-existing** tier is the load-bearing scope guardrail. Pre-existing bugs are tagged, not dropped, but never block — they're suggested as separate GitHub issues.

## Red flag categories (damage beyond the diff)

1. **Irreversibility** — destructive migration, schema drop, ID-space change
2. **Architectural lock-in** — new abstraction layer that future code will accrete to
3. **Surface widening** — new public API, new auth surface, new file upload, new IAM grant
4. **Foot-gun introduction** — API that *invites* misuse by callers
5. **Supply-chain delta** — new dep with postinstall script, recent maintainer change, version range opened up
6. **Intent laundering** — silent catch, swallowed error, fail-open default
7. **Observability debt** — new failure mode without log / metric / alert
8. **Pre-existing bug touched but not fixed** — flag-and-tag, don't block

## Install

This repo is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) — clone it into your `~/.claude/skills/` directory:

```bash
git clone https://github.com/mattnowdev/super-review.git ~/.claude/skills/super-review
```

Then in Claude Code, the skill is auto-discovered. Invoke with:

- `/super-review <PR_URL_or_number>` or `/sr`
- "Super review on PR #N"
- Paste a GitHub PR URL and say "review this"

> Note on the name: this is a standalone skill, **not** part of the `superpowers:*` plugin pack. The naming overlap is cosmetic.

## Usage

```bash
# Full review on a GitHub PR
/sr https://github.com/owner/repo/pull/42

# Fast mode for small PRs
/sr fast https://github.com/owner/repo/pull/42

# Security-only on the current branch
/sr sec
```

The skill resolves the diff target by priority:

1. Explicit GitHub URL / PR number you pass
2. Current branch vs `main`/`master`
3. Staged changes
4. Working tree

If the diff exceeds ~3000 LOC, it proposes chunking by subsystem before proceeding.

## Composes with

This skill is designed to compose with, not duplicate, existing primitives:

| Existing skill | How `super-review` uses it |
|---|---|
| `security-review` | Baked into the Cybersec L5 reviewer prompt in Phase 1 |
| `superpowers:dispatching-parallel-agents` | The dispatch mechanism for Phase 1 |
| `superpowers:verification-before-completion` | Phase 2 evidence gate + Phase 5 byte-accuracy spot-checks |
| `superpowers:receiving-code-review` | Recommended downstream — what the *author* does with this report |
| `deep-thinking-partner` Stage 3 | Phase 3 COLLIDE: contradictions, negative space, forced contrarian |

## Output format

Single GitHub comment per PR, structure:

```markdown
🔧 **Super review — <mode> mode**

**Verdict:** Ready to merge | Needs attention | Needs work

### ⚠️ Red flags (damage beyond the diff)
<≤3 items>

### 🔴 BLOCK
### 🟠 FIX-BEFORE-MERGE
### 🟡 FIX-FOLLOWUP
### ⚪ Nits (≤3; plus N similar)

### ✅ Reviewed and cleared
<what was checked and found clean — buys credibility>

### 🟣 Pre-existing bugs touched (file separately)
<one-liners; NEVER blocks this PR>
```

Each finding includes: **file:line range**, **verbatim code quote**, **one-sentence impact**, **one-sentence fix**.

## Banned patterns

The skill auto-flags and rejects these phrasings in finding bodies:

- "could be problematic", "might cause issues", "this looks suspicious"
- "consider extracting", "naming could be clearer"
- "should add a comment", "would be good practice"
- Any finding without `file:line` + verbatim quote
- Any finding whose only justification is "the linter would catch this"
- Any finding scoped to a file the diff did not modify (unless explicitly tagged 🟣 pre-existing)

## Failure modes this skill mitigates

| Failure mode | Mitigation |
|---|---|
| Over-reporting | Hard caps per severity tier |
| Hallucinated line numbers | Phase 2 byte-accuracy check + Phase 5 spot-checks |
| Scope creep into pre-existing bugs | 🟣 PRE-EXISTING tier (tagged, never blocks) |
| Intent laundering | Commit messages stripped in Phase 0 |
| Verification theatre | Phase 2 must re-open files; no re-reading text only |
| Compounding pessimism | Opus meta-pass in Phase 4 catches Sonnet cascade |
| Agreement bias | Phase 3 forced-contrarian step |
| Token blow-up | Chunking proposal at >3000 LOC |

## Influences and sources

The pipeline shape and rules synthesize patterns from:

- [Compound Engineering — Every.to](https://every.to/source-code/compound-engineering-how-every-codes-with-agents) — single-concern subagents + learning capture
- [Anthropic Code Review (managed)](https://code.claude.com/docs/en/code-review) — 🟣 pre-existing tier as scope guardrail
- [`anthropics/claude-code` `code-review` plugin](https://github.com/anthropics/claude-code/tree/main/plugins/code-review) — 4-agent parallel + 80-confidence threshold
- [`getsentry/skills` `security-review`](https://github.com/getsentry/skills) — HIGH-only confidence rule + data-flow tracing
- [`trailofbits/skills`](https://github.com/trailofbits/skills) — `differential-review`, `fp-check`, `sharp-edges`, `supply-chain-risk-auditor`, `variant-analysis`
- [`obra/superpowers`](https://github.com/obra/superpowers) — `requesting-code-review`, `dispatching-parallel-agents`, `verification-before-completion`
- [LogRocket — "I let Claude review my PRs"](https://blog.logrocket.com/claude-pr-review-caught-vs-missed/) — failure mode taxonomy
- [HN — "There is an AI code review bubble"](https://news.ycombinator.com/item?id=46766961) — practitioner consensus on noise vs signal

## Status

Personal use; shared publicly so others can adopt + adapt. Battle-tested against real PRs but treat as a starting point — tune the reviewer roles, severity caps, and banned-pattern list to your stack.

## Contributing

PRs welcome. The skill is opinionated — if you have a strong case for changing a phase, a cap, or a banned pattern, open an issue first so we can discuss the principle.

## License

MIT — see [LICENSE](./LICENSE).
