# super-review semantic-diff helper (reference implementation)

A minimal Node.js helper conforming to the [Phase 0.5 spec](../../references/semantic-diff-helper.md). Produces an AST-lite diff for TypeScript / JavaScript files that the orchestrator consumes to:

- Avoid hallucinated line numbers (positions come from parsed symbols, not raw diff text)
- Find callers of modified functions across the repo
- Catch flow-sensitive issues (signature changed → callers may break)

## Install

Zero npm dependencies. Just point `.super-review.json` at the script:

```json
{
  "superReviewHelper": {
    "path": "/path/to/super-review/helpers/semantic-diff/index.mjs",
    "timeout_seconds": 30
  }
}
```

If you have the plugin installed via `claude plugin install super-review`, the helper lives under `~/.claude/plugins/installed/super-review/helpers/semantic-diff/index.mjs`.

## Usage

The orchestrator invokes it from the target repo's working directory:

```bash
node /path/to/index.mjs <BASE_SHA> <HEAD_SHA>
```

Stdout is a single JSON object matching the spec. Stderr is for diagnostic warnings (parse failures, missing files).

Manual test:

```bash
cd /path/to/your-repo
node ~/.claude/plugins/installed/super-review/helpers/semantic-diff/index.mjs main HEAD | jq .
```

## What it extracts (TypeScript / JavaScript)

- **Top-level function declarations** (`function foo()`, `async function foo()`, `export function foo()`, `export default function foo()`)
- **Arrow / function-expression consts** (`const foo = () => {}`, `export const foo = function () {}`)
- **Class declarations** + their **methods** (qualified as `ClassName#methodName`)
- **Type aliases** (`type X = ...`)
- **Interfaces** (`interface X {}`)
- **Imports** — added/removed module symbols per file
- **Endpoints** — Fastify / Express / Next.js App Router route handlers

For each changed symbol: `kind`, `name`, `qualified_name` (file-prefixed), `diff_kind` (added / deleted / modified), line range, before/after signature where applicable, and (for modified/deleted) up to 10 callers found via `git grep`.

## Coverage matrix

| Language | Symbol extraction | Imports | Endpoints | Callers |
|---|---|---|---|---|
| TypeScript / TSX | ✅ regex-based | ✅ | ✅ | ✅ grep |
| JavaScript / JSX | ✅ regex-based | ✅ | ✅ | ✅ grep |
| Python | language_breakdown only | – | – | – |
| Go | language_breakdown only | – | – | – |
| Rust | language_breakdown only | – | – | – |
| Other | language_breakdown only | – | – | – |

Other languages are recognized for the file-language tally but produce no symbol-level diff. Adding a language is a matter of writing a new `extract*` function — pure Node, no other ceremony.

## Limitations (honest)

This is a regex-based extractor, not a real AST parser. Specifically:

- **Doesn't handle**: type-only imports tracking, destructured imports, decorators, namespaces, generators, getters/setters, class field initializers, nested function expressions, JSX-heavy components where the function body bleeds across many lines
- **End-line precision**: only start lines are reliable. End lines are reported as start line + 0 (single line); reviewers infer the end from context. A full AST parser would track them properly.
- **Method detection**: scope-tracking is via brace counting, which is fooled by `{` inside strings/regexes/template literals
- **Caller search**: `git grep` for symbol name returns false positives for common names (`get`, `update`, `init`)

These limitations are **acceptable for the orchestrator's use case** — the goal is to give reviewers ground-truth line numbers for *what changed* and *who calls it*, not a complete refactor-grade symbol table.

## Upgrading to real AST

Two recommended drop-in replacements:

1. **ts-morph** — `npm install ts-morph` then use the TypeScript Compiler API for proper symbol resolution. ~2x slower but bulletproof.
2. **web-tree-sitter** — WASM-based, multi-language (TS, Python, Go, Rust, etc.) in one binary, no native compile. ~3x slower but covers all stacks.

Either keeps the same output schema. PRs welcome to add a `--engine=ast` flag selecting the AST-grade backend when installed.

## Performance

- Reads files via `git show <sha>:<path>` — one process per file. For a 200-file diff, expect ~3-5 seconds total wall time.
- For 2000-file diffs, the helper exceeds 30s timeout; the orchestrator skips Phase 0.5 gracefully (this is expected — chunk the review).

## Tests

```bash
cd ../../tests/golden && ./run.sh
```

The golden harness runs the helper against the seed cases and verifies it produces a sensible JSON output (no crashes on malformed input).
