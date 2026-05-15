---
name: compound-pr-review
description: >
  Compound multi-agent PR review pipeline. Dispatches N specialist reviewers in
  parallel (security, correctness, design, migration, perf, supply-chain, blast-
  radius), gates findings through an evidence-quoting false-positive filter, runs
  cross-reviewer collision + Opus meta-verification, and synthesizes a bounded,
  actionable report scoped strictly to the PR diff. Use when the user says
  "review this PR", "compound review", "/compound-pr-review", "/cpr", or pastes a
  github PR URL and asks for review. Tuned for L5 software + L5 cybersec.
---

# Compound PR Review

Parallel specialist reviewers → adversarial false-positive gate → meta-verifier → synthesis. Findings ship only if twice-confirmed with quoted code evidence. Scope is bounded to the PR diff; pre-existing bugs are tagged separately and never block.

## Architecture

```
Phase 0: SCOPE-LOCK & GROUND      (single agent; defines diff bounds + context brief)
Phase 1: PARALLEL REVIEW          (N specialist subagents, single message)
Phase 2: FALSE-POSITIVE GATE       (each finding re-derived from quoted code)
Phase 3: COLLIDE                  (cross-reviewer contradictions + negative space)
Phase 4: OPUS META-VERIFICATION   (catch compounding pessimism + missed positives)
Phase 5: SYNTHESIZE & POST         (bounded report → GitHub comment + local summary)
```

## Modes

- **Full** (default): all 5 phases. ~6-12 minutes for a non-trivial PR.
- **Fast** (`/cpr fast`): Phase 0 → Phase 1 (≤3 reviewers) → Phase 2 → Phase 5. Skip collision + meta. Use for PRs <200 LOC or trusted authors.
- **Security-only** (`/cpr sec`): Phase 0 → cybersec + supply-chain reviewers only → full gate. Use when auth/crypto/IAM changes dominate.

Announce mode at start: `Using compound-pr-review in <mode> mode.`

### Phase-artifact requirement (anti-skip gate)

**Every phase in the active mode MUST produce a named artifact.** Missing artifact = skill failure; do not advance.

| Phase | Required artifact |
|---|---|
| 0 | `<pr>/scope.md` — written scope brief (file inventory, stack signals, CLAUDE.md rules quoted). Not implicit. |
| 1 | `<pr>/reviewers/<role>.md` — one file per dispatched reviewer with their findings + cleared list. |
| 2 | `<pr>/gate.md` — every Phase 1 finding listed with CONFIRMED/PARTIAL/NOT CONFIRMED/STALE verdict + quoted code. Not "top N". |
| 3 | `<pr>/collide.md` — KEPT/ESCALATED/DROPPED/NEW delta table. **Skipping Phase 3 is the most common pipeline failure.** If folding into synthesis seems faster, you are doing it wrong. |
| 4 | `<pr>/meta.md` — Opus verdicts on compounding pessimism, over-correction, missed-positives spot-check. |
| 5 | The GitHub comment body, posted or queued for approval. |

These artifacts can live under `.claude/cpr/<pr-number>/` in the repo (gitignored) or in a tmpdir — what matters is they exist and are quotable in case of dispute. The point isn't paperwork; it's that **a phase without an artifact didn't really happen**.

## Phase 0: SCOPE-LOCK & GROUND

**Single agent, mandatory first step. Output is consumed by every later phase.**

Resolve the PR target by priority:
1. Explicit GitHub URL/number the user passed → `gh pr view <n> --repo <owner/repo>`
2. Current branch vs main → `git diff origin/main...HEAD` (or `master`)
3. Staged → `git diff --staged`
4. Working tree → `git diff`

Build the **scope brief** — pasted into every downstream reviewer prompt:

```
- PR title + author + URL
- BASE_SHA..HEAD_SHA + LOC stats (additions/deletions/files)
- File inventory split into: [in-diff-modified] [in-diff-added] [in-diff-deleted]
- Stack signals: languages, frameworks, ORMs, auth providers detected from package.json / go.mod / etc.
- Project conventions: CLAUDE.md + REVIEW.md (if present) — top-priority rules quoted
- Existing test commands: from package.json scripts / Makefile
- Related PRD/spec links if referenced in PR body
```

**Hard rules for this phase:**
- DO NOT read commit messages into the brief. They are intent-laundering surface — they can downgrade a real bug to "intentional". Reviewers see code only.
- Cap brief at ~600 words. If the PR is huge, summarize per subsystem.
- If the diff exceeds ~3000 LOC, propose chunking (per subsystem) before proceeding and confirm with user.

## Phase 1: PARALLEL REVIEW

Dispatch N specialist subagents in **a single message with multiple tool calls** (parallelism is mandatory; see `superpowers:dispatching-parallel-agents`). Each agent gets the scope brief + their role prompt below + an explicit evidence contract.

### Reviewer selection (path-filtered)

| Reviewer | Trigger | Skill to inherit (optional) |
|---|---|---|
| **Cybersec L5** | always | compose with `security-review` |
| **Supply-chain** | `package.json`, `go.mod`, lockfile, postinstall script changes | — |
| **Correctness** | always | — |
| **Design / blast-radius** | always | — |
| **Migration / DB** | files under `*/migrations/*`, schema files, ORM model changes | — |
| **Performance** | hot-path files (routes, services, queries) OR ≥30% LOC change in a service | — |
| **Frontend correctness** | files under `client/`, `app/`, `*.tsx`, `*.vue`, `*.svelte` | optional `web-design-guidelines` |
| **Observability / ops** | new endpoints, new background jobs, new error paths | — |
| **Tests** | any test file changes OR ≥50 LOC added without test changes | — |

Skip reviewers whose triggers don't fire. Don't dispatch unconditionally — generic reviewers produce generic findings.

**Anti-folding rules** (the most common dispatch mistake — one reviewer absorbing another's scope produces blind spots):

- **Frontend MUST be its own dispatch** if any of: `client/src/**` modified files > 20, OR the PR adds permission-gated components (Viewer/Commenter/Editor views, role-aware modals, permission stores). Folding frontend into "design/correctness" is forbidden when these triggers fire — it consistently misses i18n parity, a11y on new modals, and role-gated affordance audits.
- **Migration MUST be its own dispatch** if any of: >1 migration file in the diff, NOT NULL columns added, indexes added, columns dropped. Folding into "design" misses tenant-scoping audits and transactionality checks.
- **Cybersec is never folded.** If you find yourself thinking "the correctness reviewer can also check auth", stop and dispatch cybersec separately.
- A folded scope must be explicitly declared at dispatch time ("Correctness reviewer also covering migration items 1-5 because the migration triggers did NOT fire") so the meta-verifier can audit the decision.

### Universal evidence contract (every reviewer)

Every finding must include:
- **Severity** (see taxonomy below) + **confidence tier** (HIGH/MED/LOW). Only HIGH ships in the final report; MED/LOW logged for the meta-verifier.
- **Scope tag**: `[in-diff]`, `[pre-existing]`, or `[amplified-pre-existing]`. Pre-existing findings are tagged, not dropped, never block.
- **File:line range** matching the actual diff hunks.
- **Verbatim code quote** (3-10 lines).
- **Why-it-matters**: one sentence on real-world impact (a user-affecting failure, not a vibe).
- **Fix**: one sentence on the concrete change.

**Red flags are not exempt.** Every ⚠️ red flag entry MUST cite at least one file:line + verbatim quote that anchors the future scenario. "Concurrency hygiene drift" alone fails the contract; "concurrency hygiene drift: file A has lock, file B:line X is RMW, file C:line Y is TOCTOU" passes. Vibe paragraphs do not ship.

**Banned phrasings** (auto-flag if produced):
- "could be problematic", "might cause issues", "this looks suspicious"
- "consider extracting", "naming could be clearer" (these are nits; cap below)
- "should add a comment", "would be good practice"
- Any finding without file:line + verbatim quote
- Any finding that infers intent from commit messages (Phase 0 strips them; reviewers must not re-fetch)

### Reviewer role prompts

Each role prompt is a fixed template. Substitute `{{SCOPE_BRIEF}}` and `{{PR_PATH}}`:

#### Cybersec L5

> You are a senior application security engineer (L5). Review only the changes in {{PR_PATH}} introduced between BASE and HEAD per {{SCOPE_BRIEF}}.
>
> **Threats to enumerate (in priority order):**
> 1. **AuthN / AuthZ**: new endpoints without auth gate; role-hierarchy bypasses; IDOR via guessable IDs; tenant scoping breaks.
> 2. **Injection**: SQL via string-concat, NoSQL operator injection, OS command injection, template injection, prompt injection sinks.
> 3. **Crypto**: weak primitives, ECB mode, MD5/SHA1 for security, JWT `alg: none`, missing signature verification, hardcoded keys, weak RNG (`Math.random()` for tokens).
> 4. **Secrets / config**: secrets in code, secrets logged, secrets in URLs, secrets in error messages, default credentials.
> 5. **Deserialization / parsing**: unsafe `eval`, `pickle`, `yaml.load`, `Function()`, regex DOS.
> 6. **SSRF / XXE / open redirect**.
> 7. **XSS**: reflected, stored, DOM via `dangerouslySetInnerHTML` / `innerHTML` / `v-html` / `bypassSecurityTrust*`.
> 8. **Mass assignment**: client-controlled fields persisted server-side without filtering (identity, role, owner_id, price).
> 9. **Race conditions**: TOCTOU on auth, lost-update on credit/balance/inventory, missing transactions on multi-step state changes.
> 10. **Rate limiting**: new auth/expensive endpoint without rate limits.
> 11. **Cryptographic identifiers**: share-tokens / invite-tokens — entropy, TTL, revocation, single-use vs reusable.
>
> **Confidence rule (Sentry pattern):** HIGH = vulnerable pattern + attacker-controlled input traced through the diff. MED = pattern only. LOW = defense-in-depth.
> **Report only HIGH.** Log MED/LOW separately for the meta-verifier.
> Cap: 8 findings. Quality over quantity. Skip OWASP-flavored generic warnings.

#### Supply-chain

> Review dependency and lockfile changes. Enumerate:
> 1. **New deps**: package age, maintainer count, recent maintainer change, GitHub stars/last-commit, postinstall script presence, license drift.
> 2. **Version bumps**: cross-major bumps, ranged versions opened up, lockfile-only edits without `package.json` change.
> 3. **Typosquats**: spelling-distance check against popular packages.
> 4. **Transitive surface**: did the lockfile pull in known-CVE versions of transitive deps?
> 5. **Postinstall / lifecycle scripts** in new deps — quote them.
> Confidence rule: HIGH only when a specific concrete risk is identified.
> Cap: 5 findings.

#### Correctness

> Review the diff for logic bugs introduced by the PR. Focus:
> 1. Off-by-one, boundary errors, null/undefined paths the diff opens.
> 2. Error contract drift: new endpoints with inconsistent error shapes; swallowed errors (`catch {}`, default-zero patterns).
> 3. Comment-code drift: comments above changed lines describing the old behavior.
> 4. Concurrency: shared mutable state introduced; missing locks/transactions; promise-fan-out without `Promise.all` error semantics understood.
> 5. Public API contracts changed silently.
> 6. Time/timezone/locale bugs in new code.
> 7. State machine: new states added without all transitions handled (`default: throw`).
> Confidence rule: HIGH = reproducible bug or test case; MED = inspection-level; LOW = code smell.
> Cap: 8 HIGH-confidence findings.

#### Design / blast-radius

> You evaluate the **damage this PR could cause beyond what the diff shows**. Categories:
> 1. **Irreversibility**: destructive migration, schema drop, ID-space change, deleted feature flag, removed backward-compat shim.
> 2. **Architectural lock-in**: new abstraction layer that future code will accrete to; new framework introduced for a single use case; new top-level module with weak boundary.
> 3. **Surface widening**: new public API, new auth surface, new file upload path, new external network call, new IAM grant.
> 4. **Coupling introduced**: new cross-module imports that weren't there; circular dependency risk; new shared mutable state.
> 5. **Foot-gun**: API that *invites* misuse by callers (no type narrowing on dangerous values, easy-to-forget cleanup, error swallowed by design).
> 6. **Intent laundering** (silent catch, swallowed error, fail-open default).
>
> Each finding must name the future damage scenario, not just describe the structure.
> Cap: 5 findings.

#### Migration / DB

> Review migration files + ORM model changes. Enumerate:
> 1. **NOT NULL** added to tables with existing rows without backfill → write failure on rollout.
> 2. **Index creation locking**: `CREATE INDEX` on large tables without `CONCURRENTLY` (Postgres) / equivalent.
> 3. **Drop columns / drop tables** with no down-migration path or unstable foreign-key references.
> 4. **Down migration is lossy** (recreates schema with defaults, discards data introduced by up).
> 5. **Multiple migrations on the same day** that could be squashed before they ship — name them.
> 6. **Tenant-scoping**: new tables missing tenant FK / RLS; new indexes missing tenant prefix.
> 7. **Transactionality**: DDL outside a transaction in a step that needs atomicity.
> Cap: 6 findings.

#### Performance

> Review hot-path changes. Enumerate:
> 1. New **N+1** queries in route/service code (ORM lazy load inside loop).
> 2. **Unbounded** list operations (no LIMIT, no pagination) on user-touchable endpoints.
> 3. **Blocking I/O** on hot path (sync FS, sync network).
> 4. **Memory** growth: in-process caches without eviction; large objects retained in closures.
> 5. **Indexes**: new queries without supporting index; new index without query usage.
> 6. **Hot-loop allocations** (per-request work that could be hoisted).
> Confidence rule: HIGH only when the new code introduces the issue (don't pile on pre-existing hot paths the diff merely touched).
> Cap: 5 findings.

#### Frontend correctness

> Review frontend changes. Enumerate:
> 1. **XSS sinks** (`dangerouslySetInnerHTML`, `innerHTML`, `v-html`, `bypassSecurityTrustHtml`).
> 2. **Role-gated UI** that *hides* affordances but leaves the action reachable (button `disabled` while handler still callable from devtools).
> 3. **Server-derived permissions ignored by client** (canDoX flag computed but never consumed at call sites).
> 4. **CLS / layout shift** on permission-loading skeletons.
> 5. **Optimistic UI** that diverges from server state on permission denial.
> 6. **Hardcoded user-visible strings** bypassing i18n (when i18n exists in the repo).
> 7. **Accessibility regressions**: removed labels, removed focus management, new `div onClick` without keyboard handler.
> Cap: 6 findings.

#### Observability / ops

> Review for production-readiness gaps in new code paths:
> 1. New failure modes without **logs / metrics / alerts**.
> 2. New endpoint without latency / error metric.
> 3. New background job without retry / DLQ / monitoring.
> 4. **PII logged**: emails, tokens, request bodies containing user data.
> 5. New external dependency without circuit-breaker / timeout.
> 6. **Rollback path**: feature flag gating new behavior? Or hard cutover?
> Cap: 5 findings.

#### Tests

> Review test changes + the test coverage of new code:
> 1. **Structural-only tests** (mock everything → assert call counts; no behavior verified).
> 2. **Snapshot tests as the only assertion** on new logic.
> 3. **New branches uncovered**: new role check / new state — no test for the denial path.
> 4. **Flakiness signatures**: arbitrary `setTimeout`, `Math.random` in test bodies, time-of-day dependencies.
> 5. **Test infra changes that mask failures** (now-skipped tests, broadened mocks).
> 6. **Negative-case coverage** missing: input validation tested only on happy path.
> Cap: 5 findings.

## Phase 2: FALSE-POSITIVE GATE

**Single fresh subagent. Does not see Phase 1 reasoning — only the findings list + the actual code.**

For each finding from Phase 1, the gate agent must:
1. Open the cited file at the cited line range.
2. Confirm the quoted code matches what's actually there (catches hallucinated quotes).
3. Independently re-derive the impact from the code alone.
4. Verdict: `CONFIRMED` | `PARTIAL` | `NOT CONFIRMED` | `STALE` (code changed under the reviewer's feet).

**Drop rules** (applied at the gate):
- `NOT CONFIRMED` → drop.
- `STALE` → re-issue to reviewer with current code.
- `PARTIAL` → keep with adjusted severity, note the adjustment.
- Lint-caught issues (run linter on the file; if it would have flagged) → drop unless severity is HIGH.
- "Pedantic nit without concrete fix" → drop.
- Any finding without verbatim quote → drop, do not surface.

Known failure mode: **Sonnet adversarial verifiers exhibit compounding pessimism** when chained without an Opus meta-pass. The gate agent must avoid rejecting on stylistic grounds — only the evidence rules above can drop a finding.

## Phase 3: COLLIDE

**Cross-reviewer contradictions and negative space.** Inspired by `deep-thinking-partner` Stage 3.

Run a single agent across all gate-confirmed findings:

1. **Exact positions, not harmonized.** List each reviewer's confirmed verdicts verbatim.
2. **Convergence challenge.** For each finding all reviewers agree on: "Would an actual L5 human reviewer agree, or is this Sonnet agreeing with Sonnet?" Flag any finding that only survives because every Sonnet pass had the same bias.
3. **Contradictions surfaced, not softened.** Security says "block, RBAC bypass"; Design says "this is the intended pattern". Report both. Name the gating question.
4. **Negative space.** Categories no reviewer touched (i18n? rollback? auth on the new endpoint?) — explicitly call out. If a category should have produced a finding given the diff, escalate to Phase 4.
5. **Forced contrarian on "merge" verdicts.** If every reviewer says ship: write the strongest case to block. Useful only if it surfaces a concrete risk.

Output: a delta of findings vs Phase 2. Categories: KEPT / ESCALATED / DROPPED / NEW (from negative space).

## Phase 4: OPUS META-VERIFICATION

**Opus, not Sonnet.** Catches the failure modes Sonnet adversarial verifiers exhibit:

- **Compounding pessimism**: Sonnet sequence escalated everything → check.
- **Over-correction**: real bugs downgraded because the gate was too eager → check by re-reading the dropped MED-confidence findings; promote any that have HIGH-confidence evidence on second look.
- **Missed positives**: scan the file inventory; for each file the parallel reviewers didn't flag, ask "is there a reason none of them caught anything here?" Random-spot-check 3 changed files reviewers were quiet about.
- **Shared-prior risk**: did all reviewers inherit the same blind spot (e.g. they all assume the framework's middleware does X)? Name it.

Output: a final findings list, ranked. This is the input to synthesis.

## Phase 5: SYNTHESIZE & POST

### Severity taxonomy (unified)

| Tier | Meaning | Examples |
|---|---|---|
| 🔴 **BLOCK** | Must fix before merge | Data loss, RCE, auth bypass, broken migration, mass-assignment of identity |
| 🟠 **FIX-BEFORE-MERGE** | Functional bug, missing test on load-bearing path, broken contract | Logic bug introduced, role-gate computed but unused, lossy migration down |
| 🟡 **FIX-FOLLOWUP** | Architecture / perf / observability concerns; file as issue | New abstraction lock-in, missing metric, blast-radius widening |
| ⚪ **NIT** | Tiny; cap 3, "plus N similar" for overflow | One-line fix, naming clarity that affects new code |
| 🟣 **PRE-EXISTING** | Bug exists on master; PR exposes/touches but doesn't introduce | Tagged separately; never blocks |
| ⚠️🟣 **AMPLIFIED-PRE-EXISTING** | Bug exists on master AND this PR materially widens its blast radius (e.g. moves it from self-only to cross-tenant) | Appears in BOTH the ⚠️ red-flag section (with the amplification scenario) AND the 🟣 footer (with the underlying bug). Never blocks merge, but must be filed as a follow-up issue. |
| ⚠️ **RED FLAG** | Damage beyond the diff — separate header section | Irreversibility, lock-in, supply-chain delta, foot-gun, intent laundering |

**Hard caps on the posted report:**
- ≤ 3 BLOCK
- ≤ 5 FIX-BEFORE-MERGE
- ≤ 5 FIX-FOLLOWUP
- ≤ 3 NIT (overflow summarized as "plus N similar")
- Unlimited PRE-EXISTING (but they go in a separate footer section)
- ⚠️ RED FLAGS in a top-of-doc section (≤ 3)

### Output template (GitHub comment)

```markdown
🔧 **Compound PR review — <mode> mode**

Two-pass review (N parallel specialists → false-positive gate → Opus meta-verify). Only twice-confirmed findings below.

**Verdict:** <Ready to merge | Needs attention | Needs work>

---

### ⚠️ Red flags (damage beyond the diff)
<≤3 items, each: one paragraph naming the future scenario + at least one file:line + verbatim quote + the trigger to invalidate the concern. ⚠️🟣 Amplified-pre-existing items go here too, marked, and ALSO appear in the 🟣 footer.>

---

### 🔴 BLOCK — must fix before merge
<each finding: file:line, evidence quote, why-it-matters, fix>

### 🟠 FIX-BEFORE-MERGE
<same shape>

### 🟡 FIX-FOLLOWUP
<same shape>

### ⚪ Nits (≤3 shown; plus N similar)
<one-liners>

---

### ✅ Reviewed and cleared
<one-liners on what was checked and found clean — buys credibility for the BLOCK list>

---

### 🟣 Pre-existing bugs touched but not introduced (file separately)
<one-liners with file:line. NEVER blocks this PR. Recommend filing as issue.>

---
<sign-off line, optional persona>
```

### Posting rules

1. **One comment per PR.** Use `gh pr comment <n> --repo <owner/repo> --body` with a heredoc.
2. If reposting after revisions: delete the prior compound-pr-review comment first (`gh api -X DELETE`) to avoid stacking.
3. If pre-existing bugs were found, **do not** post them on the PR. Offer to file as separate issues (`gh issue create`). Touching them on the PR creates scope creep — the lesson from real reviews.
4. Permalinks: include the head SHA in file:line citations if the author may force-push (`https://github.com/<owner>/<repo>/blob/<SHA>/<path>#L<start>-L<end>`).

## Evidence discipline (composable from `strategy-generator:evidence-discipline`)

- Every finding ends with `file:path:line` + a verbatim code quote.
- Confidence tier explicit: HIGH only ships. MED/LOW only in the meta-verifier's working notes.
- No commit-message reasoning. No author-intent inference. Code only.
- 5 random spot-checks at the end of Phase 5: pull 5 cited line ranges, re-open the files, confirm the quoted code is byte-accurate.

## Banned patterns (auto-flag in finding bodies)

- "could be problematic", "might cause issues", "this looks suspicious", "would be nice to"
- "consider extracting", "naming could be clearer"
- "should add a comment", "would be good practice"
- Any finding without file:line + verbatim quote
- Any finding whose justification is "the linter would catch this"
- Any finding scoped to a file the diff did not modify (unless tagged 🟣 pre-existing)

## Failure modes to watch

1. **Over-reporting** — ~75% useful is the practitioner-good baseline. Caps + drop rules in Phase 2 enforce this.
2. **Hallucinated line numbers** — Phase 2 byte-accuracy check + Phase 5 spot-checks.
3. **Scope creep into pre-existing bugs** — Phase 0 scope-lock + 🟣 PRE-EXISTING tier as the safety valve, never blocks.
4. **Intent laundering** — commit messages stripped in Phase 0; reviewers see code only.
5. **Verification theatre** — Phase 2 gate must open files and re-derive impact; not just re-reading the finding text.
6. **Compounding pessimism** — Sonnet adversaries cascade; Opus meta in Phase 4 catches this.
7. **Agreement bias** — Phase 3 forced-contrarian step.
8. **Diff-size token blow-up** — chunk by subsystem if >3000 LOC; confirm chunking with user.

## What this skill is NOT

- Not a replacement for human review on the load-bearing decisions. AI catches off-by-one, auth gaps, migration footguns; humans catch business intent and architectural fit.
- Not a substitute for CI. Tests + linters + type checks run before this skill — assume they're green.
- Not for first-pass triage in 30 seconds. For that, use a single-agent `review` invocation.
- Not for the *recipient* side of feedback — that's `superpowers:receiving-code-review`. Chain into it after this skill posts.

## Composing with existing skills

- **`security-review`** → bake into the Cybersec L5 reviewer prompt above (Phase 1).
- **`superpowers:dispatching-parallel-agents`** → the actual dispatch mechanism in Phase 1.
- **`superpowers:verification-before-completion`** → Phase 2 evidence gate + Phase 5 spot-checks.
- **`strategy-generator:evidence-discipline`** → citation/confidence rules.
- **`strategy-generator:stress-test`** → can be invoked at end of Phase 4 as an extra adversarial wrap.
- **`deep-thinking-partner`** Stage 3 COLLIDE → directly applied in Phase 3.

## Triggers

- `/compound-pr-review <PR_URL_or_number>` (also: `/cpr`)
- "Compound review on PR #N"
- "Full review of this branch"
- Any GitHub PR URL pasted with "review"
- After `/finishing-a-development-branch` selects "merge" — chain into compound-pr-review for the final pass.
