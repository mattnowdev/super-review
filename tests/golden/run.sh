#!/usr/bin/env bash
# Golden-PR harness runner.
#
# Modes:
#   ./run.sh                          run all cases (manual review mode — see HARNESS_MODE below)
#   ./run.sh 001 003                  run specific cases
#   HARNESS_MODE=auto ./run.sh        invoke super-review automatically (requires Claude Code CLI + ANTHROPIC_API_KEY)
#   HARNESS_MODE=manual ./run.sh      print case prompts; you produce findings.json yourself per case; scorer runs at end
#
# Per-case execution:
#   1. Build a scratch git repo with `base/` files committed as BASE_SHA
#   2. Apply `pr.diff` and commit as HEAD_SHA
#   3. (auto) invoke super-review against the scratch repo and capture findings to results/<case>/findings.json
#      (manual) print BASE_SHA..HEAD_SHA and the diff; tester reviews and writes findings.json
#   4. Run score.mjs against the case's expected.json + findings.json
#
# Output: results/<case>/{findings.json, score.txt}; aggregate verdict at end.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${HARNESS_MODE:-manual}"
CASES_DIR="$HERE/cases"
RESULTS_DIR="$HERE/results"
mkdir -p "$RESULTS_DIR"

# Discover cases
if [ $# -eq 0 ]; then
  CASES=($(ls "$CASES_DIR"))
else
  CASES=()
  for arg in "$@"; do
    # Match by case-id prefix (e.g. "001" matches "001-share-link-token-in-logs")
    match=$(ls "$CASES_DIR" | grep -E "^$arg" | head -1)
    if [ -z "$match" ]; then
      echo "✗ no case matches: $arg"
      exit 2
    fi
    CASES+=("$match")
  done
fi

PASS=0
FAIL=0
SKIPPED=0

for case_name in "${CASES[@]}"; do
  case_dir="$CASES_DIR/$case_name"
  result_dir="$RESULTS_DIR/$case_name"
  mkdir -p "$result_dir"

  echo ""
  echo "=========================================="
  echo "  $case_name"
  echo "=========================================="

  if [ "$MODE" = "auto" ]; then
    # Build scratch repo
    scratch=$(mktemp -d)
    git -C "$scratch" init -q
    cp -R "$case_dir/base/." "$scratch/"
    git -C "$scratch" add -A
    git -C "$scratch" -c user.email=harness@local -c user.name=Harness commit -q -m "base"

    base_sha=$(git -C "$scratch" rev-parse HEAD)
    git -C "$scratch" apply --whitespace=nowarn "$case_dir/pr.diff"
    git -C "$scratch" add -A
    git -C "$scratch" -c user.email=harness@local -c user.name=Harness commit -q -m "PR under review"
    head_sha=$(git -C "$scratch" rev-parse HEAD)

    echo "Scratch repo: $scratch ($base_sha..$head_sha)"

    if ! command -v claude &> /dev/null; then
      echo "  ⚠ claude CLI not found; skipping auto invocation"
      SKIPPED=$((SKIPPED + 1))
      rm -rf "$scratch"
      continue
    fi

    # Invoke super-review against the scratch repo; expect findings JSON written to result_dir
    (cd "$scratch" && claude --no-interactive \
      "/super-review:run smells $base_sha..$head_sha --json-output $result_dir/findings.json" \
      > "$result_dir/run.log" 2>&1) || true

    rm -rf "$scratch"

    if [ ! -f "$result_dir/findings.json" ]; then
      echo "  ✗ super-review did not produce findings.json (see run.log)"
      FAIL=$((FAIL + 1))
      continue
    fi
  else
    # Manual mode: print the diff + path to expected; tester writes findings.json
    echo ""
    echo "MANUAL MODE — review this diff and write findings to:"
    echo "  $result_dir/findings.json"
    echo ""
    echo "Diff:"
    sed 's/^/  /' "$case_dir/pr.diff"
    echo ""
    echo "Expected (ground truth — do NOT peek before reviewing):"
    echo "  $case_dir/expected.json"
    echo ""
    if [ ! -f "$result_dir/findings.json" ]; then
      echo "  ⚠ no findings.json yet; skipping scorer. Re-run after writing it."
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  # Score
  if node "$HERE/score.mjs" "$case_dir" "$result_dir/findings.json" | tee "$result_dir/score.txt"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "=========================================="
echo "  AGGREGATE"
echo "=========================================="
echo "  passed:  $PASS"
echo "  failed:  $FAIL"
echo "  skipped: $SKIPPED"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
