---
description: >
  Orchestrator for the super-review plugin. 5-phase multi-agent PR review:
  parallel specialists (security, correctness, design, migration, perf,
  supply-chain, blast-radius) → evidence-quoted false-positive gate →
  cross-reviewer collision → Opus meta-verification → bounded synthesis. Phase 0
  auto-loads sibling sub-skills (react, nextjs, postgres, orm, crypto,
  web-headers, llm-sec) based on stack detection. Use when the user says
  "review this PR", "super review", "/super-review:run", or pastes a github PR
  URL and asks for review. Tuned for L5 software + L5 cybersec.
---

# Super Review — orchestrator (`super-review:run`)

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
- **Fast** (`/sr fast`): Phase 0 → Phase 1 (≤3 reviewers) → Phase 2 → Phase 5. Skip collision + meta. Use for PRs <200 LOC or trusted authors.
- **Security-only** (`/sr sec`): Phase 0 → cybersec + supply-chain reviewers only → full gate. Use when auth/crypto/IAM changes dominate.

Announce mode at start: `Using super-review in <mode> mode.`

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

These artifacts can live under `.claude/super-review/<pr-number>/` in the repo (gitignored) or in a tmpdir — what matters is they exist and are quotable in case of dispute. The point isn't paperwork; it's that **a phase without an artifact didn't really happen**.

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
- **Project conventions** (`CLAUDE.md` + `REVIEW.md` + `AGENTS.md` + `GEMINI.md` if present) — **mandatory read.** Quote EVERY load-bearing rule into the brief verbatim, not summarized. Project rules outrank universal taxonomies when in conflict (e.g. CLAUDE.md says "Polish-first, no emoji, no exclamation points" — those become BLOCKERs even if not in OWASP). The orchestrator MUST surface project rules to every reviewer's prompt; reviewers cite project rules by file:line in CLAUDE.md the same way they cite OWASP IDs.
- Existing test commands: from package.json scripts / Makefile
- Related PRD/spec links if referenced in PR body
- Sub-skill loadout (see below): list of super-review sub-skills whose triggers fire on this diff
```

**Sub-skill detection** — also in Phase 0, decide which bundled reference packs to load into reviewer prompts:

| Sub-skill | Trigger (any of) |
|---|---|
| `super-review:react` | `react`/`react-dom` in `package.json`; `*.tsx` / `*.jsx` in the diff |
| `super-review:nextjs` | `next` in `package.json`; `app/` or `pages/` or `middleware.ts` in the diff |
| `super-review:postgres` | `pg` / `postgres` / `@neondatabase/*` / `pg-promise` in deps; `*.sql` or `migrations/` in the diff |
| `super-review:orm` | `@prisma/client` / `@mikro-orm/*` / `typeorm` / `drizzle-orm` in deps |
| `super-review:crypto` | `crypto.create*`, `jsonwebtoken`, `jose`, `bcrypt`, `argon2`, `node:crypto` imports in the diff |
| `super-review:web-headers` | Response-header setters, middleware files, `next.config.*` headers config, `vercel.json` headers |
| `super-review:llm-sec` | `openai` / `@anthropic-ai/sdk` / `@ai-sdk/*` / `langchain` / `llamaindex` / pinecone / weaviate / qdrant in deps or diff |
| `super-review:i18n` | `next-intl` / `react-intl` / `react-i18next` / `i18next` / `lingui` / `@formatjs/*` / `vue-i18n` in deps, OR `locales/`/`messages/`/`i18n/` dir, OR translation JSON/YAML in diff |
| `super-review:code-smells` | Single-file diff > 150 LOC, new class with > 5 methods, function moves across files, OR explicit `smells` mode |
| `super-review:typescript` | `*.ts` / `*.tsx` in diff OR `tsconfig.json` modified |
| `super-review:testing` | Test files in diff (`*.test.*`, `*.spec.*`, `__tests__/`) OR ≥ 50 LOC production code added without corresponding tests |
| `super-review:accessibility` | `client/` / `app/` / `*.tsx`/`*.jsx`/`*.vue`/`*.svelte` files OR HTML templates in diff |
| `super-review:graphql` | `graphql` / `@apollo/*` / `@graphql-tools/*` / `mercurius` / `type-graphql` / `nexus` in deps, OR `*.graphql` / `*.gql` / resolver files in diff |
| `super-review:python` | `*.py` files in diff OR `pyproject.toml` / `requirements.txt` / `Pipfile` modified |
| `super-review:go` | `*.go` files in diff OR `go.mod` / `go.sum` modified |
| `super-review:rust` | `*.rs` files in diff OR `Cargo.toml` / `Cargo.lock` modified |
| `super-review:kubernetes` | `*.yaml`/`*.yml` with `apiVersion:` + `kind:` markers, OR `helm/` / `kustomize/` / `k8s/` / `manifests/` dirs in diff |
| `super-review:dockerfile` | `Dockerfile`, `Dockerfile.*`, `*.dockerfile`, `docker-compose.yml`, `.dockerignore` in diff |
| `super-review:terraform` | `*.tf` / `*.tfvars` / `terragrunt.hcl` / `cdktf/` in diff |
| `super-review:llm-prompts` | `prompts/` dir, `*.prompt.{md,txt}`, `*.prompts.{yaml,json}`, `eval/` LLM datasets, OR system-prompt string literals > 200 chars in code |

For each fired trigger, the orchestrator reads the corresponding `skills/<name>/SKILL.md` and appends its anti-pattern catalog to the **Cybersec L5**, **Correctness**, and **Design** reviewer prompts (or only the ones for which the catalog is relevant — e.g. `crypto` → Cybersec only). The brief records which sub-skills were loaded.

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
> **Enumerate threats against these canonical taxonomies. Cite the ID(s) with every finding:**
>
> **OWASP Top 10 2021** (web application, current release as of 2026):
> - A01 Broken Access Control · A02 Cryptographic Failures · A03 Injection
> - A04 Insecure Design · A05 Security Misconfiguration · A06 Vulnerable/Outdated Components
> - A07 Identification & Authentication Failures · A08 Software/Data Integrity Failures
> - A09 Security Logging/Monitoring Failures · A10 SSRF
>
> **OWASP API Top 10 2023** (every endpoint touched is in scope):
> - API1 BOLA (object-level authz — the IDOR class) · API2 Broken Authentication
> - API3 BOPLA (property-level authz — mass assignment) · API4 Unrestricted Resource Consumption
> - API5 Function-Level Authz · API6 Unrestricted Access to Sensitive Business Flows
> - API7 SSRF · API8 Security Misconfiguration · API9 Improper Inventory Mgmt · API10 Unsafe Consumption of APIs
>
> **OWASP LLM Top 10 2025** (any code that calls an LLM, ingests AI output, or builds prompts):
> - LLM01 Prompt Injection (direct + **indirect** via tool input, retrieved docs, file content)
> - LLM02 Sensitive Information Disclosure · LLM03 Supply Chain (model/data provenance)
> - LLM04 Data and Model Poisoning · LLM05 Improper Output Handling (model output used as code/SQL/HTML/shell)
> - LLM06 Excessive Agency (model with tool access exceeds caller's privileges)
> - LLM07 System Prompt Leakage · LLM08 Vector/Embedding Weaknesses
> - LLM09 Misinformation · LLM10 Unbounded Consumption
>
> **CWE Top 25 2024** (cite specific CWE-IDs when applicable):
> CWE-79 XSS · CWE-787 OOB Write · CWE-89 SQLi · CWE-352 CSRF · CWE-22 Path traversal
> CWE-125 OOB Read · CWE-78 OS command injection · CWE-416 UAF · CWE-862 Missing authz
> CWE-434 Unrestricted upload · CWE-94 Code injection · CWE-20 Improper input validation
> CWE-77 Command injection · CWE-287 Improper authentication · CWE-269 Improper priv mgmt
> CWE-502 Deserialization of untrusted data · CWE-200 Information exposure
> CWE-863 Incorrect authz · CWE-918 SSRF · CWE-476 NULL deref · CWE-798 Hardcoded creds
> CWE-190 Integer overflow · CWE-400 Uncontrolled resource consumption · CWE-306 Missing auth for critical function
>
> **2025-era threat addendum** (categories that have eaten real production code in the last 24 months and are not yet fully reflected in the lists above):
> - **Indirect prompt injection**: user-controlled content + retrieved docs + tool output flowing into LLM prompts without delimiter discipline or output validation.
> - **AI output as executor input**: model-generated SQL / shell / HTML / code passed to interpreters or rendered without sandboxing.
> - **Supply-chain primitives** (post-axios, post-xz, post-eslint-config-prettier): any new dep with a `postinstall` / `preinstall` script; maintainer change < 90 days old; cross-major version bumps; lockfile-only edits without `package.json` deltas; missing sigstore/cosign or SLSA-provenance verification on releases that should have it.
> - **Cloud IMDS / SSRF**: requests to `169.254.169.254`, link-local, RFC1918 private ranges, DNS-rebinding-prone host validation, IPv6 mapped variants.
> - **JWT modern flaws**: alg confusion (HS256 verified with RS256 public key as HMAC secret), `kid` header path-traversal/SQLi, missing `aud`/`iss` validation, refresh tokens with no rotation, JWT-as-session-cookie.
> - **Webhook handlers**: missing HMAC signature verification, missing timestamp/nonce check (replay), constant-time compare not used.
> - **GraphQL**: missing query depth/complexity limit, introspection enabled in prod, alias abuse for rate-limit evasion, batched mutations bypassing per-call auth.
> - **Prototype pollution sinks**: `Object.assign` / `_.merge` / `JSON.parse → assign` paths with attacker-controlled keys (`__proto__`, `constructor`, `prototype`).
> - **Serverless state reuse**: in-memory caches/globals shared across invocations of the same warm Lambda/Worker — auth state, user context, request ID bleed.
> - **Modern XSS**: trusted-types bypass; framework sanitizer escapes (`dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust*`, `{@html}`); attribute-injected `javascript:` URLs in `<a href>` / `<form action>` / `<iframe src>`.
> - **Concurrency primitives**: lost-update on counters/balances (read-modify-write to a remote store), TOCTOU on auth checks before async work, double-spending of share-link / invite tokens.
>
> **Confidence rule (Sentry-pattern):** HIGH = vulnerable pattern + attacker-controlled input traced through the diff. MED = pattern matches but input source unclear. LOW = defense-in-depth only.
> **Report only HIGH.** Log MED/LOW separately for the meta-verifier.
>
> **Every finding must cite: OWASP ID(s) + CWE ID + file:line range + verbatim code quote + concrete exploit scenario (one sentence) + fix (one sentence).**
> Cap: 8 findings. Don't list a category without concrete code evidence. Skip generic "you should validate input" — only specific, exploitable findings ship.

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

> You evaluate the **damage this PR could cause beyond what the diff shows**. Three lenses: structural risk, principle violations (only when load-bearing), distributed-systems hygiene (only when relevant).
>
> **Structural risks** (every finding names the future damage scenario, not just the structure):
> 1. **Irreversibility**: destructive migration, schema drop, ID-space change, deleted feature flag, removed backward-compat shim.
> 2. **Architectural lock-in**: new abstraction layer that future code will accrete to; new framework for a single use case; new top-level module with weak boundary.
> 3. **Surface widening**: new public API, new auth surface, new file upload path, new external network call, new IAM grant.
> 4. **Coupling introduced**: new cross-module imports that weren't there; circular dependency risk; new shared mutable state.
> 5. **Foot-gun**: API that *invites* misuse by callers (no type narrowing on dangerous values, easy-to-forget cleanup, error swallowed by design).
> 6. **Intent laundering**: silent catch, swallowed error, fail-open default, default value masking a missing key.
> 7. **Chesterton's Fence**: PR removes a guard / fallback / weird-looking code without naming what it was for.
>
> **Principle violations** (only flag when concretely load-bearing — not every SRP nit ships):
> - **SOLID**:
>   - **SRP** — class/module with two clearly distinct reasons to change in the diff
>   - **OCP** — pattern of modifying existing class to add a case, where the case should have been new subtype/strategy
>   - **LSP** — subtype broken parent contract (return type narrowed to throw, precondition strengthened, postcondition weakened)
>   - **ISP** — fat interface forces consumers to implement methods they don't use
>   - **DIP** — high-level module imports concrete low-level (`import { PostgresClient }` in a use-case file)
> - **DRY**: real duplication of logic (copy-pasted with one tweak that will diverge), not "looks similar". Three similar lines is not duplication.
> - **YAGNI**: new abstraction with zero current second caller. New config flag with no consumer.
> - **Law of Demeter**: `a.b.c.d.method()` chains crossing module boundaries.
> - **Postel's Law**: input-validation strictness drift on the receive side; new endpoint accepting fields the schema doesn't declare.
> - **Hyrum's Law**: behavior other code now depends on, being changed silently (timestamp precision, ordering of iteration, default value, error message text used in tests).
> - **Conway's Law leak**: module boundary mirrors team boundary, not problem boundary.
>
> **Distributed-systems checklist** (flag only when the diff introduces or modifies network calls / queues / RPC / cross-service state):
> - **8 fallacies of distributed computing** — which one is the PR assuming away? (network reliable, latency zero, bandwidth infinite, network secure, topology stable, one administrator, transport homogeneous, transport cost zero)
> - **Idempotency**: retries safe? unique idempotency key? at-least-once delivery handled? duplicate-detection window?
> - **Timeout / retry / backoff**: defined? bounded? jittered? per-request budget?
> - **Circuit breaker / bulkhead / pool isolation** on new external call?
> - **Clock skew**: code assumes monotonic / synchronized clocks across hosts?
> - **Causality / ordering**: messages may re-order? exactly-once vs at-least-once semantics explicit?
> - **Saga / 2PC / outbox / SAGA-compensating-action**: distributed transaction across services without a coordination pattern?
> - **Partial failure**: what happens if half the writes succeed?
>
> Each finding must name the **specific future scenario** the issue enables, with a concrete trigger that would falsify the concern.
> Cap: 6 findings.

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
🔧 **Super review — <mode> mode**

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

**Preferred: inline review threads.** Findings are posted as **per-line inline review threads** via:

```
gh api repos/<owner>/<repo>/pulls/<n>/reviews \
  -F commit_id=<head_sha> \
  -F event=COMMENT \
  -F 'body=<top-level summary>' \
  -F 'comments[][path]=<file>' \
  -F 'comments[][line]=<line>' \
  -F 'comments[][body]=<finding body>' \
  -F 'comments[][side]=RIGHT'
```

Why: each finding becomes a resolvable thread on the diff line where it lives; PR authors can mark `Resolve conversation` per-issue; line context renders inline. The single top-level review body contains only the **verdict + finding index + red flags + cleared list** — individual findings live in their respective threads.

If inline threads can't be posted (e.g. line not in the diff hunk because the finding spans a moved file), **fall back to a single summary comment with that finding included inline**.

Fallback summary-comment rules (unchanged):

1. **Always post via `--body-file`, never via heredoc.** Markdown bodies must be written to a temp file (e.g. `/tmp/super-review-<pr>-body.md`) and posted with:
   ```
   gh pr comment <n> --repo <owner/repo> --body-file /tmp/super-review-<pr>-body.md
   ```
   **Why:** shell heredocs mangle backticks. A `` ``` `` inside `bash -c "$(cat <<'EOF' ... EOF)"` consistently survives as literal `` \``` `` in the rendered comment, breaking every code fence. This bug shipped on the first production run of this skill — do not repeat it. Editing existing comments uses the same rule via `gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@/tmp/file.md`.
2. **Verification after post.** Pull the rendered body back (`gh api repos/<owner>/<repo>/issues/comments/<id> --jq '.body' | grep -c '^```'`) and confirm the code-fence count is even and matches what you posted. Asymmetric or zero count = re-edit before declaring done.
3. **One comment per PR.** If reposting after revisions: delete the prior super-review comment first (`gh api -X DELETE`) to avoid stacking — OR edit-in-place via PATCH (preferred when only content changed, keeps the original URL stable).
4. If pre-existing bugs were found, **do not** post them on the PR. Offer to file as separate issues (`gh issue create`). Touching them on the PR creates scope creep — the lesson from real reviews.
5. Permalinks: include the head SHA in file:line citations if the author may force-push (`https://github.com/<owner>/<repo>/blob/<SHA>/<path>#L<start>-L<end>`).

## Evidence discipline

- Every finding ends with `file:path:line` + a verbatim code quote (3-10 lines).
- Confidence tier explicit: HIGH only ships. MED/LOW only in the meta-verifier's working notes.
- **Cybersec findings additionally cite OWASP ID(s) + CWE ID.** "Auth gap" alone fails; "API1 BOLA / CWE-862 — endpoint trusts user-supplied `bookId` without authz check at controllers/foo.ts:42-48" passes.
- No commit-message reasoning. No author-intent inference. Code only.
- 5 random spot-checks at the end of Phase 5: pull 5 cited line ranges, re-open the files, confirm the quoted code is byte-accurate.
- Banned qualifiers anywhere in a finding: "could be", "might", "consider", "would be nice", "looks suspicious". Use them only with a concrete anchor (file:line + verbatim quote) that makes the qualifier load-bearing.

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

## Per-repo configuration: `.super-review.json`

If the target repo contains `.super-review.json` at root, Phase 0 reads it and applies overrides. Schema reference: `.super-review.schema.json` at this plugin's root.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/mattnowdev/super-review/main/.super-review.schema.json",
  "caps": {
    "block": 3,
    "fix_before_merge": 5,
    "fix_followup": 5,
    "nit": 3,
    "red_flag": 3
  },
  "disabledReviewers": ["frontend"],          // skip frontend for backend-only services
  "disabledSubSkills": ["accessibility"],     // skip a11y if not relevant
  "severityOverrides": {                       // promote/demote specific patterns
    "new-endpoint-without-metric": "BLOCK",
    "long-method": "NIT"
  },
  "patternAllowlist": [                        // patterns the team consciously accepts
    { "skill": "crypto", "pattern": "math-random-tokens", "paths": ["tests/fixtures/**"] }
  ],
  "redFlagAddons": [                           // project-specific red flags
    { "name": "schema migration during business hours", "trigger": "migrations/*.ts" }
  ],
  "crossModelCheck": {                         // Phase 4.5
    "enabled": false,
    "model": "gpt-5",
    "onlyFor": ["BLOCK", "FIX-BEFORE-MERGE"]
  },
  "autoFileIssues": false,                     // auto gh issue create for 🟣 pre-existing
  "tokenBudget": {
    "warnAboveUsd": 1.00,
    "abortAboveUsd": 5.00
  }
}
```

Reviewers' prompts include the relevant overrides; the orchestrator validates the file against the schema and refuses to proceed if invalid (with the validation error).

## Phase 0.5: SEMANTIC DIFF (when available)

**Optional — strongest accuracy gain when present.** If a tree-sitter helper is configured (via `superReviewHelper` config or `~/.claude/super-review/helpers/semantic-diff`), Phase 0 invokes it to produce an AST-level diff: which functions/classes/symbols changed, their callers, type flow. Output goes into the scope brief and is consumed by reviewers to:

- Avoid hallucinated line numbers (positions come from the AST, not raw diff text)
- Find call sites of changed functions across the codebase
- Catch flow-sensitive issues (variable mutability changed → callers affected)

If no helper is configured, Phase 0.5 is skipped and reviewers use raw `git diff` (current behavior). Helper interface spec: see `references/semantic-diff-helper.md` in this plugin root.

## Phase 4.5: CROSS-MODEL CHECK (optional)

**Defends against "Claude agreeing with Claude" shared-prior risk.** Enabled via config `crossModelCheck.enabled: true`. After Phase 4 (Opus meta), the orchestrator invokes the configured external model (GPT-5 / Gemini 3 / etc.) on the final findings list and asks: *"Re-derive the impact of each of these N findings from the cited code alone. Report DISAGREE if the impact doesn't follow."*

Any DISAGREE with concrete reasoning → demote one severity tier (BLOCK → FIX-BEFORE-MERGE, etc.) and flag in the meta artifact. Doesn't drop findings; just adjusts confidence. Skip if model returns rate-limit / timeout.

## Phase 6: APOLOGIZE-AND-RE-REVIEW (post-author-response)

**Triggered on demand**, not automatic. When the PR author has replied to inline threads, the orchestrator can re-read its own findings against author pushback:

- For each thread with author response: classify as `accept` / `partial` / `dispute`.
- For `dispute`: re-derive the finding from code. If the author cited concrete evidence (file:line, test result, external reference), retract with an apology comment. If the author said "no" without evidence, hold and explain why.
- Output is a new top-level comment summarizing accepted retractions + held findings + new findings (if author's response surfaced a related issue).

Triggered via `/super-review:run rereview <PR>`.

## Cross-PR memory

Per-repo: `.claude/super-review/<repo>/history.jsonl`. Each line: `{ pr, finding_id, skill, pattern, severity, file_line, outcome }`. Outcomes captured: `merged` (accepted), `dismissed-by-author` (with optional reason), `dropped-by-meta`, `cross-model-disagreed`.

Phase 2 reads history at startup and **down-weights** patterns this repo has historically rejected as FP (drop them at the gate unless evidence is HIGH-confidence + new file). Phase 4 **escalates** patterns this repo keeps re-introducing despite past flags (the PR doesn't fix it, history shows N similar occurrences → upgrade severity AND propose a CLAUDE.md edit).

Memory is gitignored by default (per-developer); teams can opt to commit it for shared learning.

## Streaming progress

Each phase emits a status marker to stdout (and to a `🤖 super-review status` PR comment that's updated in-place when running in CI):

```
▸ Phase 0 (scope-lock + config + sub-skill detection)... done in 12s
▸ Phase 1 (parallel: 7 reviewers)... done in 4m 02s — 23 findings
▸ Phase 2 (false-positive gate)... done in 1m 14s — 14 confirmed, 9 dropped
▸ Phase 3 (collide)... done in 38s — 2 escalated, 1 new from negative space
▸ Phase 4 (Opus meta)... done in 51s — 1 demoted, 0 missed positives
▸ Phase 4.5 (cross-model check, gpt-5)... done in 27s — 0 disagreed
▸ Phase 5 (synthesize + post)... 14 findings posted as inline threads
```

This is the user-facing contract; no progress = the skill silently hung; debug accordingly.

## Token budget estimator

Before Phase 1 dispatch, the orchestrator estimates token spend from: file count, average file size in diff, reviewer count, sub-skill catalog sizes. Output:

```
Estimated cost for this run:
  Phase 1 (7 reviewers × ~25k tokens each)  ~$0.92
  Phase 2 (gate, 1 agent × ~40k)            ~$0.18
  Phase 3 (collide, 1 × ~30k)               ~$0.14
  Phase 4 (Opus meta × ~50k)                ~$0.45
  ─────────
  Total estimated:                          ~$1.69
```

If above `tokenBudget.warnAboveUsd` → confirm with user before proceeding. If above `abortAboveUsd` → abort and propose chunking.

## Onboarding mode

`/super-review:run --onboard` runs a one-time "discover your stack + propose conventions" pass on a fresh repo:

1. Walks the codebase, detects stack signals + conventions
2. Drafts a starter `CLAUDE.md` listing inferred rules
3. Drafts a starter `.super-review.json` with reasonable caps for the team size
4. Outputs a PR with both files; team reviews and merges to opt-in to super-review

Use once per repo.

## Auto-file 🟣 pre-existing as issues

If config `autoFileIssues: true`, every pre-existing bug discovered (but never blocking the PR per the scope rule) is auto-filed via `gh issue create --label super-review-preexisting --title "..." --body "..."`. The PR comment includes a reference: "✅ 3 pre-existing bugs filed as separate issues: #142, #143, #144."

If `autoFileIssues: false` (default), they're just listed in the PR comment for the team to triage.

## Bundled sub-skills (loaded on-demand by Phase 0)

The `super-review` plugin ships these sibling skills. The orchestrator detects which apply to a given diff (see Phase 0 sub-skill detection table) and appends their anti-pattern catalogs to the relevant reviewer prompts. None are required — if none trigger, the pipeline runs with the inline taxonomy only.

- **`super-review:react`** — React 18.3 → 19+ anti-patterns (useEffect races, hydration, key prop, `use()`, `useActionState`, React Compiler interactions)
- **`super-review:nextjs`** — Next.js 15/16 (Server Actions, RSC boundary, `use cache` directive, async request APIs, parallel routes)
- **`super-review:postgres`** — Postgres 16/17/18 (lock escalation, deadlocks, JSONB indexing, MVCC, pgBouncer, PG17 MERGE, PG18 virtual generated columns)
- **`super-review:orm`** — Prisma 5/6, MikroORM, TypeORM, Drizzle (N+1, transaction propagation, raw SQL escape hatches, Prisma 6 breaking changes)
- **`super-review:crypto`** — Application crypto (RNG, AES-GCM IV reuse, padding oracles, JWT, password hashing, RSA, TLS, key separation)
- **`super-review:web-headers`** — CSP / HSTS / CORS / COOP+COEP / Permissions-Policy / SRI / cookie attributes / CHIPS
- **`super-review:llm-sec`** — LLM app security depth (indirect prompt injection, output-as-executor, slopsquatting, excessive agency, tool-arg validation, vector store risks)
- **`super-review:i18n`** — Internationalization (key parity, ICU pluralization, locale-naive formatting, RTL, translated-text test assertions)
- **`super-review:code-smells`** — Fowler / refactoring.guru catalog (Bloaters, OO Abusers, Change Preventers, Dispensables, Couplers, plus Flag Arguments / Stringly Typed / Magic Numbers)
- **`super-review:typescript`** — TS 5.x specifics (`any` vs `unknown`, `as` vs guards, `satisfies`, `using`, branded types, `assertNever`, `const` type params, `NoInfer`)
- **`super-review:testing`** — Test-code quality (structural-mock-only, snapshot abuse, brittle selectors, missing negative cases, AAA violations)
- **`super-review:accessibility`** — WCAG 2.2 (focus management, target size 2.5.8, dragging 2.5.7, accessible auth 3.3.8/9, focus appearance 2.4.11)
- **`super-review:graphql`** — depth/complexity limits, field-level authz, N+1 + DataLoader, persisted queries, alias-abuse rate-limit bypass
- **`super-review:python`** — mutable defaults, bare excepts, type-hint drift, sync-in-async, dataclass slots, modern 3.12/3.13 features
- **`super-review:go`** — goroutine leaks, context propagation, typed-nil interface, `%w` wrapping, channel direction, race-condition patterns
- **`super-review:rust`** — `unwrap`/`Clone` discipline, async cancellation soundness, `Arc<Mutex>` vs channels, `thiserror` vs `anyhow`, unsafe + SAFETY
- **`super-review:kubernetes`** — resource limits, securityContext, NetworkPolicy, PDB, runAsNonRoot, secret-as-file vs env
- **`super-review:dockerfile`** — non-root user, multi-stage, `.dockerignore`, build-cache layering, secret mounts vs ARG
- **`super-review:terraform`** — state locking, `for_each` vs `count`, lifecycle.prevent_destroy, provider pinning, IAM via policy-document
- **`super-review:llm-prompts`** — structured output schemas, eval datasets, instruction/data delimiters, output-length caps, version pinning
- **`super-review:audit-self`** — meta-skill that reviews super-review's own past findings on a repo, proposes config patches + prompt edits. Invoke periodically.

## Optional external enhancements (use if installed; pipeline gracefully no-ops otherwise)

- **[`deep-thinking-partner`](https://github.com/mattnowdev/deep-thinking-partner)** — Phase 3 COLLIDE is *inspired by* its Stage 3 pattern. If installed, delegate to it for richer adversarial collision; otherwise the inline instructions suffice.
- **Anthropic stock `security-review`** (bundled with Claude Code) — a simpler one-shot cybersec pass. Use only for `fast` mode when you want a quick lighter scan; not a substitute for the OWASP/CWE-anchored Cybersec L5 reviewer above.
- **[`obra/superpowers`](https://github.com/obra/superpowers)** — `dispatching-parallel-agents` and `verification-before-completion` add rigor to Phase 1 / Phase 5 when installed.

## What this skill is NOT

- Not a replacement for human review on load-bearing decisions. AI catches off-by-one, auth gaps, migration footguns; humans catch business intent and architectural fit.
- Not a substitute for CI. Tests + linters + type checks run before this skill — assume they're green.
- Not for first-pass triage in 30 seconds. For that, use Anthropic's stock `review` skill.
- Not for the *recipient* side of feedback — that's `superpowers:receiving-code-review`. Chain into it after this skill posts.

## Triggers

- `/super-review:run <PR_URL_or_number>` — full pipeline (default mode)
- `/super-review:run fast <PR>` — fast mode (<200 LOC PRs)
- `/super-review:run sec <PR>` — security-only mode
- `/super-review:run smells <PR>` — code-smells emphasis
- `/super-review:run --onboard` — one-time stack detection + scaffolds `CLAUDE.md` + `.super-review.json` for a fresh repo
- `/super-review:run rereview <PR>` — Phase 6 re-evaluation after author has responded to inline threads
- "Super review on PR #N"
- "Full review of this branch"
- Any GitHub PR URL pasted with "review"
- After `/finishing-a-development-branch` selects "merge" — chain into `super-review:run` for the final pass.

For periodic skill calibration: `/super-review:audit-self` (separate sub-skill).
