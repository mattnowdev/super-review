#!/usr/bin/env node
// super-review semantic-diff helper — minimal reference implementation
//
// Conforms to references/semantic-diff-helper.md spec.
//
// Usage:
//   node index.mjs <BASE_SHA> <HEAD_SHA>   (run from inside the target git repo)
//
// Coverage:
//   - TypeScript / JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs) — full symbol extraction
//   - Other languages — listed in language_breakdown but no symbol-level diff
//
// Implementation notes:
//   - Pure Node, zero runtime dependencies (no `npm install` needed by users)
//   - Uses regex-based AST-lite extraction tuned for top-level + class-member symbols
//   - Caller search is grep-based across the working tree
//   - Limitations are documented in README.md alongside this file
//
// Future:
//   - Drop-in replacement using ts-morph / tree-sitter WASM for full AST fidelity
//   - Per-language modules: python.mjs, go.mjs, rust.mjs

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const [, , BASE, HEAD] = process.argv;
if (!BASE || !HEAD) {
  console.error("usage: index.mjs <BASE_SHA> <HEAD_SHA>");
  process.exit(2);
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function fileAt(sha, path) {
  try {
    return sh(`git show ${sha}:${shellQuote(path)} 2>/dev/null`);
  } catch {
    return null;
  }
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Discover changed files
const changedFilesRaw = sh(`git diff --name-status ${BASE}..${HEAD}`).trim();
if (!changedFilesRaw) {
  console.log(JSON.stringify({ version: "1", language_breakdown: {}, changed_symbols: [], changed_imports: [], new_endpoints: [], warnings: [] }));
  process.exit(0);
}

const changedFiles = changedFilesRaw.split("\n").map(line => {
  const [status, ...rest] = line.split("\t");
  const path = rest.join("\t");
  return { status, path };
});

// Language detection
const EXT_LANG = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift",
  sql: "sql", yml: "yaml", yaml: "yaml",
  json: "json", md: "markdown",
};
const languageBreakdown = {};
for (const { path } of changedFiles) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? "other";
  languageBreakdown[lang] = (languageBreakdown[lang] ?? 0) + 1;
}

// Symbol extraction (TS/JS only in this reference impl)
const TS_JS_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);

function extractSymbols(source) {
  if (!source) return [];
  const lines = source.split("\n");
  const symbols = [];

  // Regex-based detection. Imperfect but practical:
  //  - top-level function declarations (incl. async, export, default)
  //  - top-level const/let/var assigned to arrow function or function expression
  //  - class declarations + their methods
  //  - type aliases + interfaces
  //  - default exports

  let inClass = null; // { name, startLine, braceDepth }
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const stripped = line.trim();

    // Track brace depth for class scope detection
    for (const ch of stripped) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") {
        braceDepth--;
        if (inClass && braceDepth < inClass.braceDepth) {
          // class ended; emit it
          const def = inClass;
          def.end_line = lineNum;
          symbols.push(def);
          inClass = null;
        }
      }
    }

    // Class declaration
    const classMatch = stripped.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      inClass = {
        kind: "class",
        name: classMatch[1],
        qualified_name: classMatch[1],
        start_line: lineNum,
        braceDepth: braceDepth, // inside class once we see {
      };
      continue;
    }

    // Method inside class (heuristic: matches typical method signature)
    if (inClass && braceDepth >= inClass.braceDepth + 1) {
      const methodMatch = stripped.match(/^(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*[<(]/);
      if (methodMatch && !["if", "for", "while", "switch", "return", "throw", "this", "super", "new"].includes(methodMatch[1])) {
        // Skip if it's a control keyword
        symbols.push({
          kind: "method",
          name: methodMatch[1],
          qualified_name: `${inClass.name}#${methodMatch[1]}`,
          start_line: lineNum,
          end_line: lineNum, // we don't track method end; reviewers infer from context
        });
      }
      continue;
    }

    // Top-level function declarations
    const fnMatch = stripped.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (fnMatch) {
      symbols.push({
        kind: "function",
        name: fnMatch[1],
        qualified_name: fnMatch[1],
        start_line: lineNum,
        end_line: lineNum, // single-line; end inferred by readers
        signature: stripped,
      });
      continue;
    }

    // Top-level const/let assigned to arrow or function expression
    const arrowMatch = stripped.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\()/);
    if (arrowMatch) {
      symbols.push({
        kind: "function",
        name: arrowMatch[1],
        qualified_name: arrowMatch[1],
        start_line: lineNum,
        end_line: lineNum,
        signature: stripped,
      });
      continue;
    }

    // Type aliases
    const typeMatch = stripped.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (typeMatch) {
      symbols.push({
        kind: "type",
        name: typeMatch[1],
        qualified_name: typeMatch[1],
        start_line: lineNum,
        end_line: lineNum,
        signature: stripped,
      });
      continue;
    }

    // Interfaces
    const ifaceMatch = stripped.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (ifaceMatch) {
      symbols.push({
        kind: "interface",
        name: ifaceMatch[1],
        qualified_name: ifaceMatch[1],
        start_line: lineNum,
        end_line: lineNum,
      });
      continue;
    }
  }

  return symbols;
}

function extractImports(source) {
  if (!source) return [];
  const imports = [];
  const lines = source.split("\n");
  for (const line of lines) {
    const m = line.match(/^import\s+(?:type\s+)?(?:(\*\s+as\s+\w+)|(\{[^}]*\})|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      const from = m[4];
      const named = m[2] ? m[2].replace(/[{}]/g, "").split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
      const star = m[1] ? [m[1]] : [];
      const def = m[3] ? [m[3]] : [];
      imports.push({ from, symbols: [...named, ...star, ...def] });
    }
  }
  return imports;
}

function detectEndpoints(source, filePath) {
  if (!source) return [];
  const endpoints = [];
  // Fastify / Express style: app.get('/path'), fastify.post('/path'), router.delete('/path')
  // Next.js App Router: file path = endpoint
  const routeRe = /\b(?:fastify|app|router)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let m;
  while ((m = routeRe.exec(source)) !== null) {
    endpoints.push({ method: m[1].toUpperCase(), path: m[2], source: filePath });
  }
  // Next.js App Router heuristic
  if (/app\/.*\/(route|page)\.tsx?$/.test(filePath)) {
    const handlers = source.matchAll(/^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm);
    for (const h of handlers) {
      const routePath = filePath.replace(/^.*?\/app\//, "/").replace(/\/(route|page)\.tsx?$/, "");
      endpoints.push({ method: h[1], path: routePath || "/", source: filePath });
    }
  }
  return endpoints;
}

// Build per-file changed-symbol list
const changedSymbols = [];
const changedImports = [];
const newEndpoints = [];
const warnings = [];

for (const { status, path } of changedFiles) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!TS_JS_EXTS.has(ext)) continue;

  const beforeSrc = status === "A" ? null : fileAt(BASE, path);
  const afterSrc = status === "D" ? null : fileAt(HEAD, path);

  if (status !== "A" && beforeSrc === null) {
    warnings.push(`could not read ${path} at ${BASE}`);
    continue;
  }
  if (status !== "D" && afterSrc === null) {
    warnings.push(`could not read ${path} at ${HEAD}`);
    continue;
  }

  const beforeSymbols = extractSymbols(beforeSrc);
  const afterSymbols = extractSymbols(afterSrc);
  const beforeMap = new Map(beforeSymbols.map(s => [s.qualified_name, s]));
  const afterMap = new Map(afterSymbols.map(s => [s.qualified_name, s]));

  // Added
  for (const [qn, sym] of afterMap) {
    if (!beforeMap.has(qn)) {
      changedSymbols.push({
        file: path,
        kind: sym.kind,
        name: sym.name,
        qualified_name: `${path}#${qn}`,
        diff_kind: "added",
        start_line: sym.start_line,
        end_line: sym.end_line,
        signature_before: null,
        signature_after: sym.signature ?? null,
      });
    }
  }

  // Removed
  for (const [qn, sym] of beforeMap) {
    if (!afterMap.has(qn)) {
      changedSymbols.push({
        file: path,
        kind: sym.kind,
        name: sym.name,
        qualified_name: `${path}#${qn}`,
        diff_kind: "deleted",
        start_line: sym.start_line,
        end_line: sym.end_line,
        signature_before: sym.signature ?? null,
        signature_after: null,
      });
    }
  }

  // Modified (same qualified_name, signature line differs)
  for (const [qn, after] of afterMap) {
    const before = beforeMap.get(qn);
    if (before && before.signature !== after.signature && before.signature && after.signature) {
      changedSymbols.push({
        file: path,
        kind: after.kind,
        name: after.name,
        qualified_name: `${path}#${qn}`,
        diff_kind: "modified",
        start_line: after.start_line,
        end_line: after.end_line,
        signature_before: before.signature,
        signature_after: after.signature,
      });
    }
  }

  // Imports diff
  const beforeImports = new Set(extractImports(beforeSrc).flatMap(i => i.symbols.map(s => `${s}::${i.from}`)));
  const afterImports = new Set(extractImports(afterSrc).flatMap(i => i.symbols.map(s => `${s}::${i.from}`)));
  const added = [...afterImports].filter(x => !beforeImports.has(x)).map(x => x.split("::")[0]);
  const removed = [...beforeImports].filter(x => !afterImports.has(x)).map(x => x.split("::")[0]);
  if (added.length || removed.length) {
    changedImports.push({ file: path, added, removed });
  }

  // Endpoints (only check the HEAD version)
  if (afterSrc) {
    newEndpoints.push(...detectEndpoints(afterSrc, path));
  }
}

// Caller search for modified symbols (grep across HEAD tree)
for (const sym of changedSymbols) {
  if (sym.diff_kind === "modified" || sym.diff_kind === "deleted") {
    try {
      const grepOut = sh(`git grep -n --no-color -E "\\b${sym.name}\\b" ${HEAD} -- 2>/dev/null | head -50`).trim();
      if (grepOut) {
        const callers = grepOut.split("\n").map(line => {
          const m = line.match(/^[a-f0-9]+:([^:]+):(\d+):/);
          return m && m[1] !== sym.file ? { file: m[1], line: parseInt(m[2], 10) } : null;
        }).filter(Boolean).slice(0, 10); // cap to 10
        if (callers.length) sym.callers = callers;
      }
    } catch {
      // grep no-match exits non-zero; that's fine
    }
  }
}

const output = {
  version: "1",
  language_breakdown: languageBreakdown,
  changed_symbols: changedSymbols,
  changed_imports: changedImports,
  new_endpoints: newEndpoints,
  warnings,
};

console.log(JSON.stringify(output, null, 2));
