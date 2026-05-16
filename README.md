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
| `super-review:i18n` | Internationalization: key parity, ICU pluralization, locale-naive formatting, RTL, error-message localization, test discipline | `next-intl`/`react-intl`/`react-i18next`/`i18next`/`lingui`/`@formatjs/*`/`vue-i18n` in deps, OR `locales/`/`messages/` dirs |
| `super-review:code-smells` | Fowler / refactoring.guru catalog: Bloaters, OO Abusers, Change Preventers, Dispensables, Couplers, plus Flag Arguments, Stringly Typed, Magic Numbers | Single-file diff >150 LOC, new class >5 methods, function moves across files, or explicit `smells` mode |
| `super-review:typescript` | TS 5.x: `any` vs `unknown`, `as` vs guards, `satisfies`, `using`, branded types, `assertNever`, `const` type params, `NoInfer` | `*.ts`/`*.tsx` in diff or `tsconfig.json` modified |
| `super-review:testing` | Test-code quality: structural mocks, snapshot abuse, brittle selectors, missing negative cases, AAA violations, masked test infra | Test files in diff or ≥50 LOC production without tests |
| `super-review:accessibility` | WCAG 2.2: target size 2.5.8, dragging 2.5.7, accessible auth 3.3.8/9, focus appearance 2.4.11, consistent help 3.2.6, redundant entry 3.3.7 | Client UI files in diff |
| `super-review:graphql` | Depth/complexity limits, field-level authz, N+1 + DataLoader, persisted queries, alias-abuse rate-limit bypass, federation `@key` authz | GraphQL libs in deps or `*.graphql` files |
| `super-review:python` | Mutable defaults, bare excepts, type-hint drift, sync-in-async, dataclass slots, 3.12/3.13 specifics (PEP 695, `@override`, free-threaded) | `*.py` or `pyproject.toml` / `requirements.txt` |
| `super-review:go` | Goroutine leaks, context propagation, typed-nil interface, `%w` wrapping, channel direction, race patterns, 1.22+ loop var, range-over-func | `*.go` or `go.mod` modified |
| `super-review:rust` | `unwrap`/`Clone` discipline, async cancellation soundness, `Arc<Mutex>` vs channels, `thiserror`/`anyhow`, unsafe + SAFETY | `*.rs` or `Cargo.toml` modified |
| `super-review:kubernetes` | Resource limits, securityContext, NetworkPolicy, PDB, runAsNonRoot, secret-as-file vs env, topology spread | K8s manifests in diff |
| `super-review:dockerfile` | Non-root user, multi-stage, `.dockerignore`, build-cache layering, secret mounts vs ARG | Dockerfile / docker-compose in diff |
| `super-review:terraform` | State locking, `for_each` vs `count`, `lifecycle.prevent_destroy`, provider pinning, IAM via policy-document | `*.tf` / `terragrunt.hcl` / `cdktf/` |
| `super-review:llm-prompts` | Structured output schemas, eval datasets, instruction/data delimiters, output-length caps, prompt version pinning | `prompts/` dir or system-prompt string literals >200 chars |
| `super-review:audit-self` | Meta: reviews super-review's own past findings on a repo, proposes config + prompt edits | Manual invoke (quarterly hygiene) |

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

Each sub-skill also ships a **"What good looks like"** section — positive patterns the reviewer can affirm in the ✅ Cleared list, not just antipatterns to flag.

## Per-repo configuration

Drop a `.super-review.json` at your repo root to tune the pipeline for your team. JSON Schema bundled at `.super-review.schema.json`. Common overrides:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/mattnowdev/super-review/main/.super-review.schema.json",
  "caps": { "block": 3, "fix_before_merge": 5 },
  "disabledSubSkills": ["accessibility"],                // skip a11y for internal admin tools
  "severityOverrides": {
    "postgres:lost-update-on-inventory": "BLOCK",         // your team's hard rule
    "design:speculative-generality": "NIT"                // you ship abstractions early on purpose
  },
  "patternAllowlist": [
    { "skill": "crypto", "pattern": "math-random-tokens", "paths": ["**/*.test.*"], "reason": "Fixtures only" }
  ],
  "crossModelCheck": { "enabled": true, "model": "gpt-5" },   // Phase 4.5
  "autoFileIssues": true,                                      // auto gh issue create for 🟣
  "tokenBudget": { "warnAboveUsd": 1.00, "abortAboveUsd": 5.00 },
  "inlineReviewThreads": true,                                 // per-line threads vs summary
  "language": "pl"                                             // primary UI language for i18n inference
}
```

## Pipeline features

Beyond the 5-phase core, v2.0 adds optional phases:

- **Phase 0.5 — Semantic diff** (if a tree-sitter helper is configured): AST-level diff feeds reviewers with changed-symbol signatures, callers, type flow. Kills hallucinated line numbers. Helper interface spec at `references/semantic-diff-helper.md`; building the helper itself is follow-up engineering.
- **Phase 4.5 — Cross-model check** (optional, configurable): external model (GPT-5 / Gemini 3) re-derives findings from cited code. DISAGREE demotes severity by one tier. Defends against "Claude agreeing with Claude" shared-prior bias.
- **Phase 6 — Apologize-and-re-review** (on demand): re-evaluates own findings against author replies on inline threads. Retracts with apology if author cited concrete evidence; holds + explains if author said "no" without evidence. Triggered via `/super-review:run rereview <PR>`.
- **Cross-PR memory**: persists findings + outcomes per repo. Phase 2 down-weights historically-rejected patterns; Phase 4 escalates patterns the repo keeps re-introducing.
- **Streaming progress markers**: each phase emits status; in CI, a `🤖 super-review status` comment is updated in-place.
- **Token-budget estimator**: pre-flight cost estimate; confirms above threshold, aborts + proposes chunking above hard cap.
- **Onboarding mode** (`--onboard`): one-time stack detection on a fresh repo; scaffolds starter `CLAUDE.md` + `.super-review.json` as a PR.
- **Auto-issue creation** for 🟣 pre-existing bugs (opt-in).

## CI integration: GitHub Action

```yaml
# .github/workflows/super-review.yml
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: mattnowdev/super-review/.github/actions/super-review@v2
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          mode: full   # or fast / sec / smells
```

Composite action: installs Claude Code CLI + super-review plugin, runs the pipeline against the current PR, posts inline review threads, emits `verdict` / `block-count` / `finding-count` outputs for downstream jobs.

## Quality regression: golden-PR harness

`tests/golden/` holds scaffolding for the regression suite: per-case directories with `pr.diff`, baseline file tree, `expected.json` (must-find + must-not-find), and a runner that scores precision/recall over a fixed corpus. Run after any sub-skill or orchestrator edit to confirm the pipeline still catches what it should and doesn't fabricate what it shouldn't. **Scaffolding only as of v2.0**; runner + seed cases are a v2.1 follow-up. Contributors welcome to land the first cases.

## Project conventions take precedence

Phase 0 reads the project's `CLAUDE.md` / `REVIEW.md` / `AGENTS.md` / `GEMINI.md` (whichever exist) and quotes every load-bearing rule into the scope brief. **Project rules outrank universal taxonomies** when they conflict — e.g. if CLAUDE.md says "Polish-first UI, no emoji, no exclamation points", those become BLOCKERs even though no OWASP/CWE ID exists for them. Reviewers cite project rules with the same precision as OWASP IDs.

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
