# Changelog

## v2.2.0 — 2026-05-16

Three meaningful additions: machine-readable JSON output flag, real working semantic-diff helper (TS/JS), and 5 more golden cases.

### Orchestrator: `--json-output <path>`

`/super-review:run --json-output <path> ...` writes a structured JSON document with the full findings list **in addition to** posting GitHub comments / inline threads. Use `--json-output -` for stdout.

Schema covers verdict, mode, PR identification, loaded config + sub-skills, phase timings, estimated + actual cost, per-finding records with stable IDs (for cross-PR memory), severity, scope, file:line, body, code quote, OWASP / CWE IDs, fix summary. Plus cleared list and auto-filed pre-existing issue numbers.

Consumers:
- Golden-PR harness `auto` mode → captures + scores against `expected.json`
- CI dashboards → pipe verdict + findings to Slack / custom reporters
- Cross-PR memory writer → uses stable `id` field as key into `history.jsonl`

If `--json-output` unset, behavior unchanged from v2.1.

### Semantic-diff helper — minimal working implementation

`helpers/semantic-diff/index.mjs` — pure Node, zero `npm install` required. Conforms to the [Phase 0.5 spec](./references/semantic-diff-helper.md).

**Coverage (this release):** TypeScript / JavaScript files get full symbol extraction (top-level function declarations, arrow consts, classes + methods, type aliases, interfaces, imports diff, route handler endpoints for Fastify / Express / Next.js). Other languages get a language-breakdown tally; no symbol-level diff yet.

**Approach:** regex-based AST-lite. Limitations honestly documented in `helpers/semantic-diff/README.md` (no decorators, no destructured imports, end-line precision is start-line-only, caller search via grep). Upgrade paths documented: ts-morph (TS-only, full fidelity) or web-tree-sitter (multi-language WASM).

**Smoke-tested against seed cases:**
- Case 001 (hook addition inside existing function body) → correctly reports no top-level symbol changes
- Case 006 (Server Action — new exported function in a new file) → correctly extracts `deletePost` with `diff_kind: "added"`, signature, line number, plus added imports `revalidatePath` and `db`

**Wire it up** in `.super-review.json`:
```json
{ "superReviewHelper": { "path": "/path/to/index.mjs", "timeout_seconds": 30 } }
```

Pipeline gracefully skips Phase 0.5 if the helper is unconfigured or times out — zero regression.

### 5 new golden cases (total: 8)

- `004-typescript-any-in-public-api` — FIX-BEFORE-MERGE. Stripe webhook handler signature widened to `any`, breaks downstream `formatAmount(amount, currency)` call where `amount` was `number | null` in the original union. Tests `super-review:typescript` reviewer's ability to follow the cross-function consequence — a shallow grep on `any` would catch the line but miss the consumer bug.
- `005-react-useeffect-race` — FIX-BEFORE-MERGE. UserProfile component grows a `useEffect` that fetches `/api/user/${userId}` and setState's without `AbortController`. Tests `super-review:react` — stale write race when `userId` changes mid-flight; user sees wrong-user data.
- `006-nextjs-server-action-no-auth` — BLOCK. New `'use server'` action file exports `deletePost(formData)` calling `db.post.delete({ where: { id: formData.get('id') } })` with no auth, no Zod, no authorization. Tests `super-review:nextjs` + `super-review:cybersec` (OWASP A01 BOLA / CWE-862, CWE-639). Also tests against the "safe because no client imports it" rationalization.
- `007-math-random-reset-token` — BLOCK. Password reset flow generates token via `Math.random().toString(36).slice(2)`. Tests `super-review:crypto` (CWE-338) — xorshift128+ state recovery enables full account takeover. Also tests against severity-demotion to "consider using" (a common LLM failure mode on crypto findings).
- `008-i18n-key-parity-drift` — FIX-BEFORE-MERGE. New `share.modal.bookClubMode` key added to `pl.json` only; `en.json` + `de.json` unchanged. Tests `super-review:i18n` — users in en/de see raw key or fallback in wrong language. Also tests that reviewer doesn't flag the (correct) component usage.

All cases ship with: `notes.md` (skill aspect exercised, expected severity, reasoning), `base/<minimal-tree>/<file>`, `pr.diff`, `expected.json` (must_find + must_not_find + tolerance).

### Honest gaps (still + new)

- Semantic-diff helper covers TS/JS only at the symbol level. Python / Go / Rust / others are recognized in language breakdown but produce no per-symbol diff. Adding them is straightforward — a new `extract*` function per language; PRs welcome.
- Auto mode of the golden harness now has a real consumer for `--json-output`, but the orchestrator implementation of the flag itself is *spec-defined* in `skills/run/SKILL.md` and will land in production with the next Claude Code interaction that exercises the run-skill against a PR with the flag set.
- More golden cases needed: K8s, Dockerfile, Terraform, GraphQL, Go, Rust, Python sub-skills all lack a dedicated case. Plan for v2.3+: 1-2 cases per sub-skill until each is covered.

---

## v2.1.0 — 2026-05-16

Ships the v2.0 promises: golden-PR harness runner + 3 seed cases, plus a contributor-facing `CLAUDE.md`.

### Golden-PR harness — runner + scorer + seed cases

- **`tests/golden/run.sh`** — case runner. Two modes:
  - `manual` (default): prints diff per case; you write findings to `results/<case>/findings.json`; scorer runs at end. Use when no Claude Code CLI is available.
  - `auto` (`HARNESS_MODE=auto`): builds a scratch git repo from `base/` + applies `pr.diff`, invokes `claude --no-interactive` against super-review, captures findings JSON, scores. Requires `ANTHROPIC_API_KEY` and the Claude Code CLI.
- **`tests/golden/score.mjs`** — generic scorer. Takes any `findings.json` + matching `expected.json` and emits `must_find` / `must_not_find` / extras analysis with colored output and exit code (0 = pass, 1 = fail).
- **Seed cases**:
  - `001-share-link-token-in-logs` — BLOCK: new `onRequest` access-log hook emits raw `request.url`; share-link routes embed token in path. Cross-file reasoning required. Derived from PR `aleksanderkaminski/Vellam#82`.
  - `002-prisma-tx-network-io` — FIX-FOLLOWUP: `await stripe.charges.create(...)` inside `prisma.$transaction` callback + outer `prisma` client used for one write inside `tx`. Tests severity calibration (perf/stability ≠ BLOCK).
  - `003-cors-credential-reflect` — BLOCK: CORS handler refactored from allow-list check to reflecting any `Origin` while still sending `Allow-Credentials: true`. Tests detection of a security pattern requiring two-line combination.

Each case ships: `notes.md` (what skill aspect it exercises), `base/...` (minimum file tree at BASE_SHA), `pr.diff`, `expected.json` (must_find + must_not_find + tolerance).

**End-to-end smoke-tested:** scorer correctly passes case 001 with a matching finding; correctly fails when severity is demoted or a forbidden finding is posted; correctly skips when no `findings.json` exists (manual mode pre-review).

### Contributor docs

- **`CLAUDE.md`** at repo root — for contributors editing the plugin itself (not users running it). Covers sub-skill writing conventions, banned phrasings, orchestrator-change discipline, golden-harness workflow, versioning + release process.

### Honest gaps (still)

- **Semantic-diff helper binary** still not bundled — see `references/semantic-diff-helper.md` for the spec. Pipeline still gracefully skips Phase 0.5 absent the helper.
- **Auto mode** of the golden harness assumes `claude --no-interactive` supports `/super-review:run --json-output <path>`. The orchestrator does not yet emit machine-readable JSON; that's a follow-up (the harness will work today in manual mode regardless).

---

## v2.0.0 — 2026-05-16

Major release. Pack now contains **22 skills** (orchestrator + 21 sub-skills) and adds 7 orchestrator features that change how the pipeline runs.

### New sub-skills (11)

- **`super-review:typescript`** — TS 5.x: `any` vs `unknown`, `as` vs guards, `satisfies`, `using`, branded types, `assertNever`, `const` type params, `NoInfer`. Auto-loads on `*.ts`/`*.tsx` / `tsconfig.json`.
- **`super-review:testing`** — test-code quality: structural mocks, snapshot abuse, brittle selectors, missing negative cases, AAA violations, masked test infra. Auto-loads on test files in diff.
- **`super-review:accessibility`** — WCAG 2.2 specifics: target size 2.5.8, dragging movements 2.5.7, accessible auth 3.3.8/9, focus appearance 2.4.11, consistent help 3.2.6, redundant entry 3.3.7. Auto-loads on client UI changes.
- **`super-review:graphql`** — depth/complexity limits, field-level authz, N+1/DataLoader, persisted queries, alias-abuse rate-limit bypass, federation `@key` authz. Auto-loads on GraphQL deps or `*.graphql`.
- **`super-review:python`** — mutable defaults, bare excepts, type-hint drift, sync-in-async, dataclass slots, 3.12/3.13 specifics (PEP 695, `@override`, free-threaded, async-gen finalization). Auto-loads on `*.py` / `pyproject.toml`.
- **`super-review:go`** — goroutine leaks, context propagation, typed-nil interface, `%w` wrapping, channel direction, race patterns, 1.22+ loop variable semantics, range-over-func. Auto-loads on `*.go` / `go.mod`.
- **`super-review:rust`** — `unwrap`/`Clone` discipline, async cancellation soundness, `Arc<Mutex>` vs channels, `thiserror`/`anyhow`, unsafe + SAFETY comments. Auto-loads on `*.rs` / `Cargo.toml`.
- **`super-review:kubernetes`** — resource limits, securityContext, NetworkPolicy, PDB, runAsNonRoot, secret-as-file vs env, topology spread. Auto-loads on K8s manifests.
- **`super-review:dockerfile`** — non-root user, multi-stage, `.dockerignore`, build-cache layering, secret mounts vs ARG. Auto-loads on Dockerfile/docker-compose.
- **`super-review:terraform`** — state locking, `for_each` vs `count`, lifecycle.prevent_destroy, provider pinning, IAM via policy-document. Auto-loads on `*.tf`.
- **`super-review:llm-prompts`** — structured output schemas, eval datasets, instruction/data delimiters, output-length caps, prompt version pinning. Auto-loads on `prompts/` dir or large system-prompt string literals.

Plus meta-skill: **`super-review:audit-self`** — reviews super-review's own past findings on a repo, proposes config patches + prompt edits. Invoke quarterly or after embarrassing misses.

### Orchestrator features (Phase 0 → Phase 6)

- **Inline review threads** (preferred posting mode) — each finding becomes a resolvable thread on its diff line via `gh api pulls/.../reviews` with per-finding `comments[]`. Top-level summary contains verdict + index + red flags + cleared list only. Falls back to summary comment if line is outside diff hunk.
- **Per-repo `.super-review.json` config** — caps, disabled reviewers, disabled sub-skills, severity overrides, pattern allow-lists, project red-flag addons, cross-model toggle, token budget. JSON Schema bundled at `.super-review.schema.json`.
- **Phase 0.5 (semantic diff)** — optional helper interface; orchestrator consumes AST diff if a tree-sitter helper is configured. Spec at `references/semantic-diff-helper.md`. Defends against hallucinated line numbers + missed call sites. Helper binary itself is a follow-up engineering project.
- **Phase 4.5 (cross-model check)** — optional external-model verifier (GPT-5 / Gemini 3 / etc.) runs over final findings to defend against "Claude agreeing with Claude" shared-prior bias. Configurable per-severity. Demotes (doesn't drop) findings the cross-model materially disagrees on.
- **Phase 6 (apologize-and-re-review)** — triggered after PR author responds to inline threads. Re-derives findings from code vs author pushback; retracts with apology if author cited evidence; holds + explains if author said "no" without evidence.
- **Cross-PR memory** at `.claude/super-review/<repo>/history.jsonl`. Phase 2 down-weights patterns this repo has historically rejected as FP; Phase 4 escalates patterns this repo keeps re-introducing despite past flags + proposes a CLAUDE.md edit.
- **Streaming progress markers** — each phase emits status to stdout (and to a `🤖 super-review status` PR comment that's updated in-place in CI). No more silent multi-minute waits.
- **Token budget estimator** — pre-flight estimate before Phase 1 dispatch. Confirms with user above `warnAboveUsd`; aborts + proposes chunking above `abortAboveUsd`.
- **Onboarding mode** (`/super-review:run --onboard`) — one-time stack detection + scaffolds starter `CLAUDE.md` + `.super-review.json` as a PR for the team to merge.
- **Auto-file 🟣 pre-existing as issues** — optional; if `autoFileIssues: true` in config, every pre-existing bug discovered is auto-filed via `gh issue create --label super-review-preexisting`.

### Infrastructure

- **GitHub Action** at `.github/actions/super-review/action.yml` — composite action that installs Claude Code + super-review plugin, runs the pipeline against the current PR, emits `verdict` / `block-count` / `finding-count` outputs. Drop into any repo's workflow without local install.
- **Golden-PR test harness scaffolding** at `tests/golden/` — directory structure + scoring schema for regression-testing the pipeline against a fixed corpus of anonymized PRs with known findings. Runner + seed cases are a v2.1 follow-up.

### Honest gaps

- **Semantic-diff helper binary** is not bundled. Spec is shipped (`references/semantic-diff-helper.md`); building the tree-sitter implementation is follow-up engineering. Pipeline gracefully skips Phase 0.5 if no helper is configured.
- **Golden-PR test harness** has the scaffolding but no runner or seed cases yet. Contributors welcome to land the first cases.
- **Phase 6 apologize-and-re-review** depends on inline threads being posted (Phase 5 inline-thread mode); won't work if running in fallback summary-comment mode.

---

## v1.1.0 — 2026-05-16

Three additions driven by review-quality feedback:

### New sub-skills

- **`super-review:i18n`** — internationalization anti-patterns: hardcoded strings bypassing i18n, locale-key parity drift, broken pluralization (one/many ternaries that fail in Polish/Russian/Arabic), locale-naive date/number/currency formatting, RTL layout bugs, tests asserting on translated strings, missing fallback strategy, concatenated translated fragments, untranslated server error messages, locale-sensitive sorting via `Intl.Collator`. Auto-loads when any i18n library is detected or `locales/`/`messages/`/`i18n/` dir exists.

- **`super-review:code-smells`** — Fowler / refactoring.guru catalog adapted for PR review: Bloaters (Long Method, Large Class, Primitive Obsession, Long Parameter List, Data Clumps), OO Abusers (Switch Statements, Temporary Field, Refused Bequest), Change Preventers (Divergent Change, Shotgun Surgery), Dispensables (Duplicate Code, Dead Code, Speculative Generality, Comments-as-explanation), Couplers (Feature Envy, Inappropriate Intimacy, Message Chains, Middle Man), plus modern additions (Flag Argument, Stringly Typed, Magic Numbers). Auto-loads on refactor-heavy diffs (>150 LOC single file, >5 methods in new class, function moves across files).

### "What good looks like" sections

Every sub-skill (`react`, `nextjs`, `postgres`, `orm`, `crypto`, `web-headers`, `llm-sec`) now ships a positive-pattern section alongside its anti-patterns. The reviewer can both flag absence ("this pattern should be here") and affirm presence in the ✅ Cleared list — buys credibility for the BLOCK findings and helps junior contributors learn the canonical shape. Each section: 4–5 patterns with verbatim good code, why-it-works rationale, and an affirmation prompt one-liner.

### Project-convention emphasis

Phase 0 now **mandatory-reads** `CLAUDE.md` / `REVIEW.md` / `AGENTS.md` / `GEMINI.md` and quotes every load-bearing rule into the scope brief verbatim. Project rules outrank universal taxonomies (OWASP/CWE/etc.) when in conflict — e.g. a project requiring "no emoji" makes emoji a BLOCKER even though no CWE applies. Reviewers cite project rules with file:line precision.

---

## v1.0.0 — 2026-05-16

**Breaking change**: restructured into a Claude Code plugin with multiple sub-skills.

### Migration

If you previously cloned the repo to `~/.claude/skills/super-review/` (single-skill layout): remove that directory and install via the new plugin marketplace path. See the [README](./README.md) for current install instructions.

### What changed

- Repo is now a Claude Code **plugin** with `.claude-plugin/plugin.json` at root + 8 sub-skills under `skills/<name>/SKILL.md`
- Orchestrator slug moved: previously the root-level `super-review` skill, now `super-review:run`
- 7 new sub-skills bundled, loaded on-demand by Phase 0 based on stack detection:
  - `super-review:react` — React 18.3 → 19+ anti-patterns
  - `super-review:nextjs` — Next.js 15/16 (Server Actions, RSC boundary, `use cache`)
  - `super-review:postgres` — PG 16/17/18 (locks, MVCC, JSONB, PG17 MERGE, PG18 generated cols)
  - `super-review:orm` — Prisma 5/6, MikroORM, TypeORM, Drizzle
  - `super-review:crypto` — RNG, AES-GCM IV reuse, JWT, password hashing
  - `super-review:web-headers` — CSP, HSTS, CORS, COOP/COEP, cookies, CHIPS
  - `super-review:llm-sec` — Indirect injection, output sinks, slopsquatting, excessive agency, vector store risks

### Why

Feedback from real PR reviews: the single-file skill was strong on process but thin on framework-specific knowledge, and what knowledge it had wasn't loaded conditionally. A Next.js PR shouldn't get reviewed with Postgres anti-pattern reminders; a pure-backend PR shouldn't drag React content into reviewer context. The plugin format lets the orchestrator detect the stack and pull only the relevant catalogs.

---

## v0.3 — 2026-05-15

Baked in OWASP Top 10 2021, OWASP API Top 10 2023, OWASP LLM Top 10 2025, CWE Top 25 2024, and 2025-era threat addendum into the Cybersec L5 reviewer prompt. Added SOLID/Demeter/Postel/Hyrum/Chesterton design principles and 8-fallacies/CAP/idempotency distributed-systems checklist to the Design reviewer. Removed all `strategy-generator:*` dependencies — skill is now self-contained.

## v0.2.1 — 2026-05-15

Enforce `--body-file` for `gh` posting; ban heredoc bodies (mangle backticks, breaks code fences). Add post-hoc verification step (count code fences).

## v0.2 — 2026-05-15

Audit-driven hardening: phase-artifact requirement (anti-skip gate), anti-folding rules for Frontend/Migration/Cybersec reviewers, new `⚠️🟣 AMPLIFIED-PRE-EXISTING` severity tier, red flags now require file:line + verbatim quote (no vibe paragraphs).

## v0.1 — 2026-05-15

Initial release as single-skill repo (`compound-pr-review`, later renamed to `super-review`).
