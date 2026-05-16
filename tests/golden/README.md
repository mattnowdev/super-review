# Golden-PR test harness

This directory holds the regression test suite for super-review's prompt quality. Run after any change to a sub-skill or the orchestrator to confirm the pipeline still catches what it should and doesn't fabricate what it shouldn't.

## Why

Prompts rot silently. A reviewer template change can fix one type of finding while regressing another, and there's no compile error to catch it. The golden harness measures precision (no hallucinations) and recall (catches known bugs) on a fixed set of anonymized PRs over time.

## Structure

```
tests/golden/
├── README.md                                  this file
├── run.sh                                     entrypoint — runs all cases
├── cases/
│   ├── 001-share-link-token-in-logs/         one directory per golden case
│   │   ├── pr.diff                            the diff to review
│   │   ├── base/                              file tree at BASE_SHA (subset that matters)
│   │   ├── expected.json                      ground truth: findings that MUST appear, MUST NOT appear
│   │   └── notes.md                           why this case exists, what it tests
│   ├── 002-prisma-tx-leak/
│   ├── 003-cors-credential-reflect/
│   └── ...
└── results/                                   gitignored; per-run output
```

## Ground truth schema (`expected.json`)

```jsonc
{
  "case_id": "001-share-link-token-in-logs",
  "must_find": [
    {
      "severity": "BLOCK",
      "skill": "cybersec",
      "file": "backend/src/server/hooks/registerHooks.ts",
      "line_range": [33, 35],
      "pattern_keyword": "share-link bearer token"
    }
  ],
  "must_not_find": [
    {
      "reason": "Pre-existing bug, not in this PR's diff. Skill must scope-bound.",
      "file": "backend/src/modules/users/decreaseUserCredit/decreaseUserCredit.ts",
      "pattern_keyword": "credit decrement race"
    }
  ],
  "tolerance": {
    "extra_findings_allowed": 3,
    "extra_must_be": ["FIX-FOLLOWUP", "NIT"]
  }
}
```

A case **passes** when:
- Every `must_find` entry is matched by a posted finding (severity, file, line within range ±2, pattern keyword present in body).
- No `must_not_find` entry is matched.
- Extra findings are within `tolerance`.

## Running

```bash
./tests/golden/run.sh            # all cases
./tests/golden/run.sh 001 003    # specific cases
```

Each case invokes super-review against the case's BASE/HEAD via a local git scratch repo, captures the resulting findings, scores against `expected.json`, and emits a per-case verdict + aggregate precision/recall.

## Adding a case

1. Find a real PR (yours or public) with a known issue
2. Anonymize: strip company names, replace user-identifying values, hash IDs
3. Reduce: keep only files that matter for the case (full repo not needed; the helper builds a minimal git history with just these files)
4. Write `expected.json` capturing what super-review SHOULD find and MUST NOT find
5. Add `notes.md` explaining what skill-aspect this case exercises (cybersec? scope-bounding? false-positive resistance?)

## Status

**Scaffolding only as of v2.0.0.** No cases shipped yet — the harness runner and a starter case (a hand-crafted version of the share-link-token-in-logs finding from PR #82) are the next deliverable. Until then, adopters can use this as a contribution template: open a PR with your own golden case and a runner that scores against it.

## Why not in CI immediately

Running the full pipeline N times per PR is expensive and slow. The plan:

1. v2.0.0: scaffold + a few seed cases (this file + the cases/ stub)
2. v2.1: real runner + 5 seed cases + per-skill regression check
3. v2.2: GitHub Action to run golden suite on PRs that touch SKILL.md files

Until then, contributors are expected to run `run.sh` locally before opening a PR that changes prompts.
