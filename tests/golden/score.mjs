#!/usr/bin/env node
// score.mjs <case_dir> <findings.json>
//
// Compares a findings.json (output of a super-review run, OR hand-written
// during manual harness mode) against the case's expected.json ground truth.
//
// Exit 0 if case passes (all must_find matched, no must_not_find matched,
// extras within tolerance). Exit 1 otherwise.
//
// findings.json schema:
//   {
//     "findings": [
//       {
//         "severity": "BLOCK" | "FIX-BEFORE-MERGE" | "FIX-FOLLOWUP" | "NIT" | "RED-FLAG",
//         "skill": "cybersec" | "postgres" | "orm" | ...,
//         "file": "...",
//         "line": 42 | [40, 48],
//         "body": "...full finding text..."
//       }
//     ]
//   }

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [caseDir, findingsPath] = process.argv.slice(2);
if (!caseDir || !findingsPath) {
  console.error("usage: score.mjs <case_dir> <findings.json>");
  process.exit(2);
}

const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8"));
const findings = JSON.parse(readFileSync(findingsPath, "utf8")).findings ?? [];

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function inRange(line, range) {
  if (typeof line === "number") {
    const [start, end] = Array.isArray(range) ? range : [range, range];
    return line >= start - 2 && line <= end + 2; // ±2 tolerance
  }
  if (Array.isArray(line)) {
    const [s, e] = line;
    const [start, end] = Array.isArray(range) ? range : [range, range];
    return !(e < start - 2 || s > end + 2); // overlap with tolerance
  }
  return false;
}

function bodyHas(body, keyword) {
  return (body ?? "").toLowerCase().includes(keyword.toLowerCase());
}

function matchesMustFind(finding, mf) {
  if (finding.severity !== mf.severity) return false;
  if (mf.skill && finding.skill !== mf.skill) return false;
  if (mf.file && finding.file !== mf.file) return false;
  if (mf.line_range && !inRange(finding.line, mf.line_range)) return false;
  if (mf.pattern_keyword && !bodyHas(finding.body, mf.pattern_keyword)) return false;
  return true;
}

function matchesMustNotFind(finding, mnf) {
  if (mnf.file && finding.file !== mnf.file) return false;
  if (mnf.pattern_keyword && !bodyHas(finding.body, mnf.pattern_keyword)) return false;
  if (mnf.severity && finding.severity !== mnf.severity) return false;
  return true;
}

let failed = false;
const matchedFindingIdx = new Set();

console.log(`${DIM}Scoring case: ${expected.case_id}${RESET}`);
console.log(`${DIM}  ${findings.length} finding(s) submitted${RESET}`);
console.log("");

// must_find
console.log("must_find checks:");
for (const mf of expected.must_find ?? []) {
  const idx = findings.findIndex((f, i) => !matchedFindingIdx.has(i) && matchesMustFind(f, mf));
  if (idx === -1) {
    console.log(`  ${RED}✗ MISSED${RESET} ${mf.severity} ${mf.skill ?? "?"} at ${mf.file}:${JSON.stringify(mf.line_range)} (keyword: "${mf.pattern_keyword}")`);
    failed = true;
  } else {
    matchedFindingIdx.add(idx);
    console.log(`  ${GREEN}✓${RESET} ${mf.severity} ${mf.skill ?? "?"} at ${mf.file}:${JSON.stringify(mf.line_range)}`);
  }
}

// must_not_find
console.log("");
console.log("must_not_find checks:");
for (const mnf of expected.must_not_find ?? []) {
  const violator = findings.find(f => matchesMustNotFind(f, mnf));
  if (violator) {
    console.log(`  ${RED}✗ FORBIDDEN FINDING POSTED${RESET}: ${violator.severity} at ${violator.file}:${JSON.stringify(violator.line)}`);
    console.log(`     reason it was forbidden: ${mnf.reason}`);
    failed = true;
  } else {
    console.log(`  ${GREEN}✓${RESET} not present: ${mnf.pattern_keyword ?? mnf.severity ?? mnf.file}`);
  }
}

// extras
console.log("");
const extras = findings.filter((_, i) => !matchedFindingIdx.has(i));
const tolerance = expected.tolerance ?? {};
const allowedExtras = tolerance.extra_findings_allowed ?? 0;
const allowedSeverities = new Set(tolerance.extra_must_be ?? []);

console.log(`extras (${extras.length} unmatched findings, ${allowedExtras} allowed):`);
let extrasFailed = 0;
for (const e of extras) {
  if (allowedSeverities.size > 0 && !allowedSeverities.has(e.severity)) {
    console.log(`  ${RED}✗ disallowed severity for extra${RESET}: ${e.severity} at ${e.file}:${JSON.stringify(e.line)}`);
    extrasFailed++;
  } else {
    console.log(`  ${YELLOW}~${RESET} extra: ${e.severity} at ${e.file}:${JSON.stringify(e.line)}`);
  }
}
if (extras.length > allowedExtras) {
  console.log(`  ${RED}✗ too many extras${RESET}: ${extras.length} > ${allowedExtras}`);
  failed = true;
}
if (extrasFailed > 0) failed = true;

console.log("");
console.log(failed ? `${RED}CASE FAILED${RESET}` : `${GREEN}CASE PASSED${RESET}`);
process.exit(failed ? 1 : 0);
