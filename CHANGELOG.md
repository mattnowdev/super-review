# Changelog

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
