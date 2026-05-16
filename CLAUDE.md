# Contributing to super-review

This file is for **contributors editing the plugin itself**, not users running it on their PRs. (Users: see [README.md](./README.md).)

## Repo layout

```
.claude-plugin/plugin.json         Plugin manifest. Bump `version` on every release.
.super-review.schema.json          JSON Schema for users' per-repo .super-review.json config.
.github/actions/super-review/      Composite GitHub Action for CI integration.
skills/
  run/SKILL.md                     The orchestrator. Phase 0–6 protocol lives here.
  <name>/SKILL.md                  One sub-skill per directory. Loaded on-demand by Phase 0.
references/
  semantic-diff-helper.md          Interface spec for the optional tree-sitter Phase 0.5 helper.
tests/golden/                      Regression suite (case fixtures + scorer).
README.md, CHANGELOG.md, LICENSE
```

## Sub-skill writing conventions

When adding or editing a sub-skill, match the existing shape exactly (study `skills/react/SKILL.md` or `skills/postgres/SKILL.md`):

1. **Frontmatter `description:` carries the load trigger.** Phase 0 reads it. Mention every glob pattern / dep name the sub-skill should auto-load on. No `name:` field — directory name is the name.
2. **Anti-patterns format**: every one needs Detection signal · Verbatim bad code · Why it's wrong · Fix · Review prompt one-liner · OWASP/CWE/WCAG ID (where applicable).
3. **"What good looks like" section** with 4–5 positive patterns: Why it works · Affirm. Reviewers can both flag absence and affirm presence in the ✅ Cleared list.
4. **No fluff**. Skip patterns that linters / type checkers / `EXPLAIN ANALYZE` would catch directly — the skill is for what tools miss.
5. **Quote sources** at the bottom for any version-specific or load-bearing claim. Use real URLs.
6. **Cap length** around ~250 lines. If you need more, split the sub-skill.

## Banned phrasings in sub-skill bodies

(Same as the user-facing skill — the meta-rules apply to our own prompts too.)

- "could be problematic", "might cause issues", "this looks suspicious"
- "consider extracting", "naming could be clearer"
- "should add a comment", "would be good practice"
- Any anti-pattern without verbatim bad code
- Any anti-pattern justified only by "the linter catches this"

## Orchestrator changes

`skills/run/SKILL.md` is the single source of truth for the phase protocol. When changing phase semantics:

1. Bump the `version` in `.claude-plugin/plugin.json` (semver: breaking-protocol = major).
2. Add a CHANGELOG entry that explains the user-facing impact (not just "edited Phase 2").
3. **Run the golden harness** (`./tests/golden/run.sh`) before opening a PR to confirm no regression on the seed cases.
4. If you add a new phase or sub-skill, also update the sub-skill detection table in `skills/run/SKILL.md` AND the README's "Pack contents" table AND the CHANGELOG's pack-stats line.

## Golden-PR harness

`tests/golden/cases/<NNN>-<slug>/` per case:

- `notes.md` — what skill aspect this case exercises
- `base/...` — minimum file tree at BASE_SHA (only files that matter for the case)
- `pr.diff` — the diff applied to produce HEAD_SHA
- `expected.json` — ground truth: `must_find` (severity / skill / file / line range / pattern keyword), `must_not_find` (false-positive traps), `tolerance` (extras allowed)

Run modes:

```bash
./tests/golden/run.sh                 # manual: prints diffs, you write findings.json per case, scorer runs
HARNESS_MODE=auto ./tests/golden/run.sh    # automatic: invokes claude CLI + super-review, captures findings
./tests/golden/run.sh 001 003         # specific cases by prefix
```

**Add a case when** super-review missed a real bug or shipped an embarrassing false positive. The case captures the regression so future prompt edits can't silently re-break it.

## Versioning + release

Semver:
- **MAJOR**: phase protocol changes (callers / authors notice), sub-skill removed, severity tier renamed
- **MINOR**: new sub-skill, new phase added, new orchestrator feature, new config field
- **PATCH**: prompt tightening, bug fix in a sub-skill, copy improvements

Release process:
1. Update `version` in `.claude-plugin/plugin.json`
2. Update `CHANGELOG.md` (new section at top, dated)
3. Update `README.md` if user-facing surface changed
4. Run golden harness — must pass
5. Commit with imperative message starting with `vX.Y.Z:`
6. `git tag vX.Y.Z && git push origin main vX.Y.Z`
7. `gh release create vX.Y.Z --notes "$(extract from CHANGELOG)"`

## What this repo is NOT

- Not a TypeScript / Python / Go / Rust linter — those exist (`eslint`, `ruff`, `vet`, `clippy`). super-review is for what they miss: reasoning across files, intent, project conventions, multi-step bugs.
- Not a CI test runner — pair with your existing CI; super-review reviews the diff after the build passes.
- Not a substitute for human review on load-bearing decisions. AI catches off-by-one / auth gaps / migration footguns; humans catch business intent and architectural fit.

## License

MIT. By contributing you agree your contributions are licensed under the same terms.
