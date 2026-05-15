# super-review

A multi-agent PR review **plugin** for [Claude Code](https://docs.claude.com/en/docs/claude-code). Ships an orchestrator plus 7 framework/security sub-skills, loaded on-demand based on the diff's stack.

Dispatches **N specialist reviewers in parallel** (cybersecurity, supply-chain, correctness, design / blast-radius, migration, performance, frontend, observability, tests), gates findings through an evidence-quoting false-positive filter, runs cross-reviewer collision + Opus meta-verification, and produces a **bounded, actionable report scoped strictly to the PR diff**.

Tuned for senior reviewers who want signal, not noise.

## Why this plugin exists

Off-the-shelf AI PR review fails the same way every time:

- **Noise volume** — flags every "could be problematic" and "consider extracting", drowning real bugs
- **Hallucinated lines** — cites code that isn't there
- **Scope creep** — comments on pre-existing bugs the PR merely *touched*, burning reviewer trust
- **Intent laundering** — reads the commit message and downgrades real security regressions
- **Verification theatre** — a "verifier" agent that re-reads the same diff without fresh evidence
- **Generic knowledge** — same review for a Next.js PR and a Spring Boot PR; misses framework-specific footguns

This plugin is opinionated about each of those failure modes. Findings ship only if **twice-confirmed with quoted code evidence**, and the output is hard-capped (≤3 BLOCK, ≤5 fix-before-merge, ≤5 follow-up, ≤3 nits + overflow summary). Framework-specific anti-patterns are loaded **only when the stack triggers fire**.

## Architecture

```
Phase 0: SCOPE-LOCK & GROUND      single agent — defines diff bounds + detects stack + loads matching sub-skills
Phase 1: PARALLEL REVIEW          N path-filtered specialist subagents (single message, parallel dispatch)
Phase 2: FALSE-POSITIVE GATE       fresh agent re-opens each file, byte-matches the quoted code, drops hallucinations
Phase 3: COLLIDE                  cross-reviewer contradictions + negative space + forced contrarian
Phase 4: OPUS META-VERIFICATION   catches Sonnet compounding-pessimism + missed positives + shared-prior blind spots
Phase 5: SYNTHESIZE & POST         bounded report → GitHub comment + local summary
```

Three modes:

- `Full` (default) — all 5 phases. ~6-12 min on a non-trivial PR
- `Fast` — Phase 0 → Phase 1 (≤3 reviewers) → Phase 2 → Phase 5. Use for PRs <200 LOC
- `Security-only` — cybersec + supply-chain reviewers only, full gate. For auth/crypto/IAM-heavy PRs

## Pack contents

The orchestrator + 7 sub-skills:

| Skill | What it brings | Auto-loads when |
|---|---|---|
| `super-review:run` | Orchestrator: 5-phase pipeline, OWASP/CWE/LLM Top 10 reference, severity taxonomy, evidence contract, posting protocol | Always — this is the entrypoint |
| `super-review:react` | React 18.3 → 19+ anti-patterns: useEffect races, hydration, key prop, `use()`, `useActionState`, Compiler interactions | `react` in deps, `*.tsx`/`*.jsx` in diff |
| `super-review:nextjs` | Next.js 15/16: Server Actions security, RSC boundary, `use cache` directive, async request APIs, parallel routes | `next` in deps, `app/`/`middleware.ts` in diff |
| `super-review:postgres` | PG 16/17/18: lock escalation, deadlocks, JSONB indexing, MVCC, pgBouncer, PG17 MERGE, PG18 virtual generated cols | `pg`/`postgres` in deps, `*.sql`/`migrations/` in diff |
| `super-review:orm` | Prisma 5/6, MikroORM, TypeORM, Drizzle: N+1, transaction propagation, raw SQL escape, Prisma 6 breaking changes | ORM in deps |
| `super-review:crypto` | Application crypto: RNG, AES-GCM IV reuse, padding oracles, JWT, password hashing, RSA, TLS, key separation | `crypto`/`jose`/`jsonwebtoken`/`bcrypt`/`argon2` in diff |
| `super-review:web-headers` | CSP / HSTS / CORS / COOP+COEP / Permissions-Policy / SRI / cookies / CHIPS | Middleware / header setters / `next.config` headers |
| `super-review:llm-sec` | LLM app security depth: indirect prompt injection, output-as-executor, slopsquatting, excessive agency, vector store risks | `openai`/`@anthropic-ai/sdk`/`@ai-sdk/*`/`langchain` etc. in diff |

## Severity taxonomy

| Tier | Meaning | Blocks merge? |
|---|---|---|
| 🔴 **BLOCK** | Data loss, RCE, auth bypass, broken migration, mass-assignment of identity | Yes |
| 🟠 **FIX-BEFORE-MERGE** | Functional bug introduced, missing test on load-bearing path, broken contract | Yes |
| 🟡 **FIX-FOLLOWUP** | Architecture / perf / observability concerns; file as separate issue | No |
| ⚪ **NIT** | Tiny; capped at 3 (rest summarized) | No |
| 🟣 **PRE-EXISTING** | Bug exists on the base branch; PR exposes but doesn't introduce it | Never |
| ⚠️🟣 **AMPLIFIED-PRE-EXISTING** | Bug exists on master AND this PR materially widens its blast radius | Never, but flagged in red flags |
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

```bash
# Add the marketplace (one-time)
/plugin marketplace add mattnowdev/super-review

# Install the plugin
/plugin install super-review@super-review
```

After install, invoke with `/super-review:run <PR_URL_or_number>` or paste a GitHub PR URL and say "review this".

For dev / experimentation without a marketplace, clone locally and point Claude Code at the directory via your IDE's plugin dev settings.

## Usage

```bash
# Full review on a GitHub PR
/super-review:run https://github.com/owner/repo/pull/42

# Fast mode for small PRs
/super-review:run fast https://github.com/owner/repo/pull/42

# Security-only on the current branch
/super-review:run sec
```

The orchestrator resolves the diff target by priority:

1. Explicit GitHub URL / PR number you pass
2. Current branch vs `main`/`master`
3. Staged changes
4. Working tree

If the diff exceeds ~3000 LOC, it proposes chunking by subsystem before proceeding.

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

Each finding includes: **file:line range**, **verbatim code quote**, **one-sentence impact**, **one-sentence fix**. Cybersec findings additionally cite **OWASP ID(s) + CWE ID**.

## Banned patterns

The orchestrator auto-flags and rejects these phrasings:

- "could be problematic", "might cause issues", "this looks suspicious"
- "consider extracting", "naming could be clearer"
- "should add a comment", "would be good practice"
- Any finding without `file:line` + verbatim quote
- Any finding whose only justification is "the linter would catch this"
- Any finding scoped to a file the diff did not modify (unless explicitly tagged 🟣 pre-existing)

## Failure modes this plugin mitigates

| Failure mode | Mitigation |
|---|---|
| Over-reporting | Hard caps per severity tier |
| Hallucinated line numbers | Phase 2 byte-accuracy check + Phase 5 spot-checks |
| Scope creep into pre-existing bugs | 🟣 PRE-EXISTING tier (tagged, never blocks) |
| Intent laundering | Commit messages stripped in Phase 0 |
| Verification theatre | Phase 2 must re-open files; no re-reading text only |
| Compounding pessimism | Opus meta-pass in Phase 4 catches Sonnet cascade |
| Agreement bias | Phase 3 forced-contrarian step |
| Generic framework knowledge | Sub-skill auto-loading: React/Next/Postgres/etc. catalogs only when triggers fire |

## Optional external skills (compose if installed)

- **[`deep-thinking-partner`](https://github.com/mattnowdev/deep-thinking-partner)** — Phase 3 COLLIDE delegates to its Stage 3 for richer adversarial frame-collision. Otherwise an inline collision pass runs.
- **Anthropic stock `security-review`** (bundled with Claude Code) — lighter alternative cybersec pass for `fast` mode. Not a substitute for the OWASP/CWE-anchored Cybersec L5 reviewer.
- **[`obra/superpowers`](https://github.com/obra/superpowers)** — `dispatching-parallel-agents` and `verification-before-completion` add rigor to Phase 1 / Phase 5.

After receiving this report, authors may want `superpowers:receiving-code-review` to structure their response.

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

Personal use; shared publicly so others can adopt + adapt. Battle-tested against real PRs but treat as a starting point — tune the reviewer roles, severity caps, banned-pattern list, and sub-skill triggers to your stack.

## Contributing

PRs welcome. The plugin is opinionated — if you have a strong case for changing a phase, a cap, a banned pattern, or a sub-skill, open an issue first so we can discuss the principle.

## License

MIT — see [LICENSE](./LICENSE).
