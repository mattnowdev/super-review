# Semantic-diff helper interface

Phase 0.5 of super-review's pipeline can consume an AST-level diff if a helper binary is configured. This document specifies the protocol so anyone can implement a helper (tree-sitter, ast-grep, Comby, language-specific tools).

## Why this exists

Reviewing raw `git diff` text has three failure modes:
1. **Hallucinated line numbers** — reviewer cites a line that doesn't exist in the file, because it inferred position from diff context
2. **Missed call sites** — finding flags a behavior change but doesn't note who calls the changed function
3. **Diff-context blindness** — finding is correct for the shown hunk but contradicted by a method 50 lines below that the hunk didn't include

An AST-aware helper resolves all three.

## Helper configuration

In `.super-review.json`:

```json
{
  "superReviewHelper": {
    "path": "/usr/local/bin/super-review-helper",
    "timeout_seconds": 30
  }
}
```

If `path` is absent, Phase 0.5 is skipped and the pipeline falls back to raw diff (current default).

## Invocation contract

The orchestrator calls:

```
<path> <BASE_SHA> <HEAD_SHA>
```

Working directory is the git repo root. Helper has 30s (configurable) to emit JSON to stdout. Exit non-zero on failure; stderr captures error message.

## Output schema

Single JSON object on stdout:

```jsonc
{
  "version": "1",
  "language_breakdown": { "typescript": 18, "sql": 2, "yaml": 1 },  // files per language
  "changed_symbols": [
    {
      "file": "backend/src/auth/bookAccess.ts",
      "kind": "function",                              // function | class | method | type | const | interface
      "name": "assertOwnerAccess",
      "qualified_name": "module:bookAccess#assertOwnerAccess",
      "diff_kind": "modified",                         // added | modified | renamed | deleted
      "start_line": 78,                                // HEAD-file line range
      "end_line": 94,
      "signature_before": "(input: { bookId: string; userId: string }) => Promise<void>",
      "signature_after": "(input: { bookId: string; userId: string }) => Promise<EffectiveRole>",
      "callers": [
        { "file": "backend/src/modules/routes/share/...", "line": 23 },
        { "file": "backend/src/modules/routes/members/...", "line": 41 }
      ],
      "type_flow_notes": [
        "Return type widened from Promise<void> to Promise<EffectiveRole>; existing callers ignoring return value continue to work."
      ]
    }
  ],
  "changed_imports": [
    { "file": "...", "added": ["clerkClient"], "removed": [] }
  ],
  "new_endpoints": [                                   // route handlers added (heuristic)
    { "file": "...", "method": "POST", "path": "/share-links/:token/accept" }
  ],
  "warnings": [                                        // helper limitations / partial parses
    "could not parse: backend/legacy/old.ts (syntax error at line 412)"
  ]
}
```

All fields except `version` are optional but recommended. Reviewers consume only what's present.

## How reviewers use it

- **Cybersec L5** reads `new_endpoints` and verifies each has an authz check in `changed_symbols` for the handler
- **Correctness** reads `callers` for each modified function and flags callers that may not handle the new signature
- **Design / blast-radius** reads `signature_before` / `signature_after` for public API contract changes
- **Phase 2 false-positive gate** uses `start_line` / `end_line` to confirm cited line numbers are real (kills hallucinated lines at the gate)

## Reference implementations (not bundled)

This plugin ships the spec, not the binary. Possible implementations:

- **tree-sitter + Node**: parse before/after files with tree-sitter, diff the symbol trees, walk imports. Fast, multi-language out of the box.
- **ast-grep** (built on tree-sitter): use its CLI in scripting mode; emit JSON.
- **Language-specific**: `tsc --noEmit --listFiles` + AST visitor for TS; `gopls` for Go; rust-analyzer for Rust. Higher fidelity, single-language only.

Recommended starter: tree-sitter + Node, since most modern stacks (TS, Python, Go, Rust, SQL) have tree-sitter grammars that work in one binary.

## Status

**Spec only as of v2.0.0.** The orchestrator references this interface in Phase 0.5; absent a helper binary, the pipeline gracefully skips Phase 0.5 and proceeds with raw diff (no regression vs v1.1.0). Building the helper is a follow-up engineering project — issues / PRs welcome.
